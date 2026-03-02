import { getSandbox, parseSSEStream, type ExecEvent, type ExecResult, type StreamOptions } from '@cloudflare/sandbox';
import type { RepoBoardDO } from './durable/repo-board';
import type { BoardIndexDO } from './durable/board-index';
import type { Repo, Task } from '../ui/domain/types';
import { buildRunLog, type RunJobParams } from './shared/real-run';
import { NonRetryableError } from 'cloudflare:workflows';
import { inspectPreviewDiscovery } from './preview-discovery';
import { LineLogBuffer } from './line-log-buffer';
import { buildWorkflowInvocationId } from './workflow-id';

type WorkflowBinding<T> = {
  create(options?: { id?: string; params?: T; retention?: { successRetention?: string | number; errorRetention?: string | number } }): Promise<{ id: string }>;
};

type Stage3Env = Env & {
  RUN_WORKFLOW?: WorkflowBinding<RunJobParams>;
  SECRETS_KV?: KVNamespace;
  RUN_ARTIFACTS?: R2Bucket;
};

type SleepFn = (name: string, duration: number | `${number} ${string}`) => Promise<void>;

export async function scheduleRunJob(env: Env, ctx: ExecutionContext, params: RunJobParams) {
  const stage3Env = env as Stage3Env;
  if (stage3Env.RUN_WORKFLOW?.create) {
    const workflowId = buildWorkflowInvocationId(params);
    return stage3Env.RUN_WORKFLOW.create({
      id: workflowId,
      params,
      retention: { successRetention: '7 days', errorRetention: '14 days' }
    });
  }

  const repoBoard = env.REPO_BOARD.getByName(params.repoId) as DurableObjectStub<RepoBoardDO>;
  await repoBoard.scheduleLocalRun(params.runId, params.mode);
  return { id: `local-alarm-${params.runId}` };
}

export async function executeRunJob(env: Env, params: RunJobParams, sleepFn: SleepFn) {
  const repoBoard = env.REPO_BOARD.getByName(params.repoId) as DurableObjectStub<RepoBoardDO>;
  const board = env.BOARD_INDEX.getByName('agentboard') as DurableObjectStub<BoardIndexDO>;
  const detail = await repoBoard.getTask(params.taskId);
  const run = await repoBoard.getRun(params.runId);
  const repo = await board.getRepo(params.repoId);
  const codexModel = detail.task.uiMeta?.codexModel ?? 'gpt-5.1-codex-mini';
  const codexReasoningEffort = detail.task.uiMeta?.codexReasoningEffort ?? 'medium';

  if (params.mode === 'evidence_only') {
    return runEvidence(env as Stage3Env, repoBoard, detail.task, repo, params.runId, sleepFn);
  }

  if (params.mode === 'preview_only') {
    return discoverPreviewAndRunEvidence(env as Stage3Env, repoBoard, detail.task, repo, params.runId, sleepFn, await getGithubPat(env as Stage3Env));
  }

  const pat = await getGithubPat(env as Stage3Env);
  const sandbox = getSandbox(env.Sandbox, params.runId);

  await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `Starting sandbox run for ${repo.slug}.`, 'bootstrap')]);
  await repoBoard.transitionRun(params.runId, { status: 'BOOTSTRAPPING', sandboxId: params.runId, appendTimelineNote: 'Sandbox bootstrapped.' });

  try {
    await sandbox.exec('mkdir -p /workspace/repo');
    await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `GitHub PAT suffix: ${pat.slice(-4)}`, 'bootstrap')]);
    await restoreCodexAuth(env as Stage3Env, sandbox, repo, params.runId, repoBoard);
    await logCodexAuthDiagnostics(sandbox, params.runId, repoBoard);
    await sandbox.gitCheckout(buildGithubCloneUrl(repo.slug, pat), {
      branch: repo.defaultBranch,
      targetDir: '/workspace/repo'
    });
    await sandbox.exec(`cd /workspace/repo && git config user.name 'AgentBoard' && git config user.email 'agentboard@local' && git checkout -b ${shellEscape(run.branchName)}`);
  } catch (error) {
    await failRun(repoBoard, params.runId, 'BOOTSTRAP_FAILED', 'bootstrap', error);
    throw error;
  }

  await repoBoard.transitionRun(params.runId, { status: 'RUNNING_CODEX', appendTimelineNote: 'Codex executing with full sandbox permissions.' });

  try {
    const prompt = buildCodexPrompt(detail.task, repo);
    await sandbox.writeFile('/workspace/task.txt', prompt);
    await sandbox.exec("bash -lc 'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex'");
    await logCodexCliDiagnostics(sandbox, params.runId, repoBoard, codexModel, codexReasoningEffort);
    const codexResult = await execStreamWithLogs(
      sandbox,
      repoBoard,
      params.runId,
      'codex',
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
cd /workspace/repo
cat /workspace/task.txt | codex exec -m ${codexModel} -c model_reasoning_effort="${codexReasoningEffort}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace/repo --json -
`)}`
    );
    if (!codexResult.success) {
      throw new NonRetryableError(codexResult.stderr || 'Codex execution failed.');
    }
  } catch (error) {
    await failRun(repoBoard, params.runId, 'CODEX_FAILED', 'codex', error, false);
    throw error;
  }

  await repoBoard.transitionRun(params.runId, {
    status: 'RUNNING_TESTS',
    appendTimelineNote: 'Codex-selected validation commands executed inside the sandbox.',
    executionSummary: { testsOutcome: 'skipped' }
  });
  await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, 'Codex was responsible for choosing and running validation commands.', 'tests')]);

  await repoBoard.transitionRun(params.runId, { status: 'PUSHING_BRANCH', appendTimelineNote: 'Preparing git diff and push.' });

  try {
    const statusResult = await sandbox.exec('cd /workspace/repo && git status --short');
    await appendCommandLogs(repoBoard, params.runId, 'push', statusResult.stdout, statusResult.stderr);
    const hasWorkingTreeChanges = Boolean(statusResult.stdout.trim());
    const baseHeadResult = await sandbox.exec(`cd /workspace/repo && git rev-parse origin/${shellEscape(repo.defaultBranch)}`);
    await appendCommandLogs(repoBoard, params.runId, 'push', baseHeadResult.stdout, baseHeadResult.stderr);
    if (!baseHeadResult.success) {
      throw new Error(baseHeadResult.stderr || `Failed to resolve origin/${repo.defaultBranch}.`);
    }

    const currentHeadResult = await sandbox.exec('cd /workspace/repo && git rev-parse HEAD');
    await appendCommandLogs(repoBoard, params.runId, 'push', currentHeadResult.stdout, currentHeadResult.stderr);
    if (!currentHeadResult.success) {
      throw new Error(currentHeadResult.stderr || 'Failed to resolve HEAD.');
    }

    const hasLocalCommit = currentHeadResult.stdout.trim() !== baseHeadResult.stdout.trim();
    if (!hasWorkingTreeChanges && !hasLocalCommit) {
      await failRun(repoBoard, params.runId, 'NO_CHANGES', 'push', 'Codex finished without producing a diff.', false);
      return;
    }

    let commitMessage: string;
    if (hasWorkingTreeChanges) {
      commitMessage = `AgentBoard: ${detail.task.title}`;
      const commitResult = await sandbox.exec(
        `cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)} && git push origin ${shellEscape(run.branchName)}`
      );
      await appendCommandLogs(repoBoard, params.runId, 'push', commitResult.stdout, commitResult.stderr);
      if (!commitResult.success) {
        throw new Error(commitResult.stderr || 'Commit and push failed.');
      }
    } else {
      const commitMessageResult = await sandbox.exec('cd /workspace/repo && git log -1 --pretty=%s');
      await appendCommandLogs(repoBoard, params.runId, 'push', commitMessageResult.stdout, commitMessageResult.stderr);
      if (!commitMessageResult.success) {
        throw new Error(commitMessageResult.stderr || 'Failed to read the existing commit message.');
      }
      commitMessage = commitMessageResult.stdout.trim() || `AgentBoard: ${detail.task.title}`;
      await repoBoard.appendRunLogs(params.runId, [
        buildRunLog(params.runId, 'Detected an existing local commit from Codex; pushing it without creating another commit.', 'push')
      ]);
      const pushResult = await sandbox.exec(`cd /workspace/repo && git push origin ${shellEscape(run.branchName)}`);
      await appendCommandLogs(repoBoard, params.runId, 'push', pushResult.stdout, pushResult.stderr);
      if (!pushResult.success) {
        throw new Error(pushResult.stderr || 'Push failed.');
      }
    }

    const shaResult = await sandbox.exec('cd /workspace/repo && git rev-parse HEAD');
    await appendCommandLogs(repoBoard, params.runId, 'push', shaResult.stdout, shaResult.stderr);
    if (!shaResult.success) {
      throw new Error(shaResult.stderr || 'Failed to resolve the pushed commit SHA.');
    }
    await repoBoard.transitionRun(params.runId, {
      commitSha: shaResult.stdout.trim(),
      commitMessage,
      headSha: shaResult.stdout.trim(),
      executionSummary: { codexOutcome: 'changes' }
    });
  } catch (error) {
    await failRun(repoBoard, params.runId, 'PUSH_FAILED', 'push', error);
    throw error;
  }

  try {
    const latestRun = await repoBoard.getRun(params.runId);
    const pr = await createPullRequest(repo, detail.task, latestRun, pat);
    await repoBoard.transitionRun(params.runId, {
      status: 'PR_OPEN',
      prNumber: pr.number,
      prUrl: pr.url,
      previewStatus: 'DISCOVERING',
      appendTimelineNote: 'Pull request opened.'
    });
  } catch (error) {
    await failRun(repoBoard, params.runId, 'PR_CREATE_FAILED', 'pr', error);
    throw error;
  }

  await discoverPreviewAndRunEvidence(env as Stage3Env, repoBoard, detail.task, repo, params.runId, sleepFn, pat);
}

async function runEvidence(env: Stage3Env, repoBoard: DurableObjectStub<RepoBoardDO>, task: Task, repo: Repo, runId: string, _sleepFn: SleepFn) {
  const run = await repoBoard.getRun(runId);
  const baselineUrl = task.baselineUrlOverride ?? repo.baselineUrl;
  const previewUrl = run.previewUrl;
  if (!previewUrl) {
    await failRun(repoBoard, runId, 'PREVIEW_FAILED', 'preview', 'Preview URL is missing, evidence cannot run.', false);
    return;
  }

  const sandbox = getSandbox(env.Sandbox, `${runId}-evidence`);
  await repoBoard.transitionRun(runId, { status: 'EVIDENCE_RUNNING', evidenceStatus: 'RUNNING', evidenceSandboxId: `${runId}-evidence` });
  await repoBoard.appendRunLogs(runId, [buildRunLog(runId, `Capturing evidence for baseline ${baselineUrl} and preview ${previewUrl}.`, 'evidence')]);

  try {
    await sandbox.exec('mkdir -p /workspace/evidence');
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, 'Installing Playwright Chromium for evidence capture.', 'evidence')]);
    const install = await sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
npx -y playwright install chromium
`)}`
    );
    await appendCommandLogs(repoBoard, runId, 'evidence', install.stdout, install.stderr);
    if (!install.success) {
      throw new Error(install.stderr || 'Playwright browser install failed.');
    }
    const before = await sandbox.exec(`npx -y playwright screenshot ${shellEscape(baselineUrl)} /workspace/evidence/before.png`);
    const after = await sandbox.exec(`npx -y playwright screenshot ${shellEscape(previewUrl)} /workspace/evidence/after.png`);
    await appendCommandLogs(repoBoard, runId, 'evidence', before.stdout + after.stdout, before.stderr + after.stderr);
  } catch (error) {
    await failRun(repoBoard, runId, 'EVIDENCE_FAILED', 'evidence', error);
    return;
  }

  const updated = await repoBoard.storeArtifactManifest(runId);
  await persistArtifactManifest(env, updated.runId, updated.artifactManifest);
  if (updated.prNumber) {
    const pat = await getGithubPat(env);
    await upsertRunComment(repo, task, updated, pat);
  }
  await repoBoard.transitionRun(runId, { status: 'DONE', evidenceStatus: 'READY', endedAt: new Date().toISOString(), appendTimelineNote: 'Evidence captured and manifest stored.' });
}

async function waitForPreview(env: Stage3Env, repoBoard: DurableObjectStub<RepoBoardDO>, repo: Repo, runId: string, sleepFn: SleepFn, pat: string) {
  const attempts = 12;
  const headSha = (await repoBoard.getRun(runId)).headSha;
  if (!headSha) {
    return undefined;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const discovery = await lookupPreviewUrl(repo, headSha, pat, repo.previewCheckName);
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, `Preview discovery attempt ${attempt}/${attempts}.`, 'preview', 'info', { headSha }),
      buildRunLog(
        runId,
        formatPreviewDiscoveryLog(discovery),
        'preview',
        discovery.previewUrl ? 'info' : 'error',
        {
          headSha,
          matchedCheck: discovery.matchedCheck ?? 'none',
          adapter: discovery.adapter ?? 'none',
          source: discovery.source ?? 'none',
          checkCount: discovery.checks.length
        }
      )
    ]);
    if (discovery.previewUrl) {
      return discovery.previewUrl;
    }
    await sleepFn(`preview-${attempt}`, 10_000);
  }

  return undefined;
}

async function discoverPreviewAndRunEvidence(
  env: Stage3Env,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  task: Task,
  repo: Repo,
  runId: string,
  sleepFn: SleepFn,
  pat: string
) {
  await repoBoard.transitionRun(runId, {
    status: 'WAITING_PREVIEW',
    previewStatus: 'DISCOVERING',
    appendTimelineNote: 'Polling GitHub checks for preview URL.'
  });
  const previewUrl = await waitForPreview(env, repoBoard, repo, runId, sleepFn, pat);
  if (!previewUrl) {
    await failRun(repoBoard, runId, 'PREVIEW_TIMEOUT', 'preview', 'Preview URL did not appear before timeout.', false);
    return;
  }

  await repoBoard.transitionRun(runId, {
    previewUrl,
    previewStatus: 'READY',
    status: 'EVIDENCE_RUNNING',
    evidenceStatus: 'RUNNING',
    appendTimelineNote: 'Running Playwright evidence.'
  });
  await runEvidence(env, repoBoard, task, repo, runId, sleepFn);
}

async function lookupPreviewUrl(repo: Repo, headSha: string, pat: string, previewCheckName?: string) {
  const response = await githubRequest(repo.slug, `/commits/${headSha}/check-runs`, pat);
  const payload = await response.json() as {
    check_runs?: Array<{
      name?: string;
      details_url?: string;
      html_url?: string;
      output?: { summary?: string | null };
      app?: { slug?: string };
    }>;
  };
  return inspectPreviewDiscovery({ ...repo, previewCheckName }, payload.check_runs ?? []);
}

function formatPreviewDiscoveryLog(discovery: Awaited<ReturnType<typeof lookupPreviewUrl>>) {
  const checks = discovery.checks.length
    ? discovery.checks
        .map((check) => {
          const parts = [
            check.name ?? '(unnamed check)',
            check.appSlug ? `app=${check.appSlug}` : undefined,
            `score=${check.score}`,
            check.matchedAdapter ? `adapter=${check.matchedAdapter}` : undefined,
            check.extracted ? 'preview=found' : 'preview=missing'
          ].filter(Boolean);
          return parts.join(' ');
        })
        .join(' | ')
    : 'no check runs returned';

  if (discovery.previewUrl) {
    return `Preview discovery matched ${discovery.matchedCheck ?? 'unknown check'} via ${discovery.adapter ?? 'unknown adapter'} from ${discovery.source ?? 'unknown source'}: ${discovery.previewUrl} | checks: ${checks}`;
  }

  return `Preview discovery found no usable preview URL. checks: ${checks}`;
}

async function createPullRequest(repo: Repo, task: Task, run: Awaited<ReturnType<RepoBoardDO['getRun']>>, pat: string) {
  const response = await githubRequest(repo.slug, '/pulls', pat, {
    method: 'POST',
    body: JSON.stringify({
      title: task.title,
      head: run.branchName,
      base: repo.defaultBranch,
      body: buildPullRequestBody(task, run)
    })
  });
  if (!response.ok) {
    throw new Error(`GitHub PR creation failed with status ${response.status}.`);
  }
  const payload = await response.json() as { number: number; html_url: string };
  return { number: payload.number, url: payload.html_url };
}

async function upsertRunComment(repo: Repo, task: Task, run: Awaited<ReturnType<RepoBoardDO['getRun']>>, pat: string) {
  if (!run.prNumber) return;
  const marker = `<!-- agentboard-run:${run.runId} -->`;
  const body = [
    marker,
    `Task: ${task.title}`,
    '',
    `Run: ${run.runId}`,
    run.previewUrl ? `Preview: ${run.previewUrl}` : 'Preview: pending',
    run.artifactManifest?.before ? `Before: ${run.artifactManifest.before.key}` : undefined,
    run.artifactManifest?.after ? `After: ${run.artifactManifest.after.key}` : undefined,
    run.artifactManifest?.trace ? `Trace: ${run.artifactManifest.trace.key}` : undefined,
    run.artifactManifest?.video ? `Video: ${run.artifactManifest.video.key}` : undefined
  ].filter(Boolean).join('\n');

  const commentsResponse = await githubRequest(repo.slug, `/issues/${run.prNumber}/comments`, pat);
  const comments = await commentsResponse.json() as Array<{ id: number; body?: string }>;
  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) {
    await githubRequest(repo.slug, `/issues/comments/${existing.id}`, pat, { method: 'PATCH', body: JSON.stringify({ body }) });
    return;
  }
  await githubRequest(repo.slug, `/issues/${run.prNumber}/comments`, pat, { method: 'POST', body: JSON.stringify({ body }) });
}

async function githubRequest(slug: string, path: string, pat: string, init?: RequestInit) {
  const response = await fetch(`https://api.github.com/repos/${slug}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${pat}`,
      'User-Agent': 'AgentBoard',
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok && response.status >= 500) {
    throw new Error(`GitHub API request failed with status ${response.status}.`);
  }
  return response;
}

function buildPullRequestBody(task: Task, run: Awaited<ReturnType<RepoBoardDO['getRun']>>) {
  return [
    `Task: ${task.title}`,
    '',
    task.description ?? '',
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    `Run ID: ${run.runId}`
  ].join('\n');
}

async function getGithubPat(env: Stage3Env) {
  const pat = await env.SECRETS_KV?.get('github_pat');
  if (!pat) {
    throw new NonRetryableError('Missing `github_pat` in KV or `SECRETS_KV` binding is not configured.');
  }
  return pat;
}

function bytesToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function restoreCodexAuth(env: Stage3Env, sandbox: ReturnType<typeof getSandbox>, repo: Repo, runId: string, repoBoard: DurableObjectStub<RepoBoardDO>) {
  if (!repo.codexAuthBundleR2Key || !env.RUN_ARTIFACTS) {
    const reason = !repo.codexAuthBundleR2Key
      ? 'No Codex auth bundle configured for this repo.'
      : 'RUN_ARTIFACTS binding is not configured.';
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, reason, 'bootstrap', 'error')]);
    throw new NonRetryableError(reason);
  }

  const object = await env.RUN_ARTIFACTS.get(repo.codexAuthBundleR2Key);
  if (!object) {
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, `Codex auth bundle ${repo.codexAuthBundleR2Key} was not found in R2.`, 'bootstrap', 'error')]);
    throw new NonRetryableError(`Codex auth bundle ${repo.codexAuthBundleR2Key} was not found in R2.`);
  }

  const archiveBase64 = bytesToBase64(await object.arrayBuffer());
  await sandbox.writeFile('/workspace/codex-auth.tgz.b64', archiveBase64);
  const restoreResult = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
base64 -d /workspace/codex-auth.tgz.b64 > /workspace/codex-auth.tgz
mkdir -p "$HOME"
tar -xzf /workspace/codex-auth.tgz -C "$HOME"
test -d "$HOME/.codex"
find "$HOME/.codex" -maxdepth 2 -type f | sort
`)}`
  );
  await appendCommandLogs(repoBoard, runId, 'bootstrap', restoreResult.stdout, restoreResult.stderr);
  if (!restoreResult.success) {
    throw new NonRetryableError('Codex auth bundle restore failed.');
  }
}

async function logCodexAuthDiagnostics(sandbox: ReturnType<typeof getSandbox>, runId: string, repoBoard: DurableObjectStub<RepoBoardDO>) {
  await sandbox.writeFile(
    '/workspace/codex-auth-diagnostics.mjs',
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
console.log(\`HOME=\${home}\`);
const codexDir = path.join(home, '.codex');
if (!fs.existsSync(codexDir) || !fs.statSync(codexDir).isDirectory()) {
  console.log('Codex dir: missing');
  process.exit(0);
}

console.log('Codex dir: present');
for (const entry of fs.readdirSync(codexDir).sort()) {
  const fullPath = path.join(codexDir, entry);
  if (fs.statSync(fullPath).isFile()) {
    console.log(fullPath);
  }
}

const authPath = path.join(codexDir, 'auth.json');
if (!fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
  console.log('Codex auth file: missing');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
console.log(\`Codex auth file: \${authPath}\`);
const apiKey = typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY ? data.OPENAI_API_KEY : null;
console.log(\`Codex OPENAI_API_KEY suffix: \${apiKey ? apiKey.slice(-4) : 'missing'}\`);
const accessToken = data.tokens && typeof data.tokens.access_token === 'string' && data.tokens.access_token
  ? data.tokens.access_token
  : null;
console.log(\`Codex access_token suffix: \${accessToken ? accessToken.slice(-4) : 'missing'}\`);
`
  );
  const diagnostics = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
node /workspace/codex-auth-diagnostics.mjs
`)}`
  );
  await appendCommandLogs(repoBoard, runId, 'bootstrap', diagnostics.stdout, diagnostics.stderr);
  if (!diagnostics.success) {
    throw new NonRetryableError('Codex auth diagnostics failed.');
  }
  const stdout = diagnostics.stdout ?? '';
  if (stdout.includes('Codex dir: missing')) {
    throw new NonRetryableError('Codex auth directory is missing after restore.');
  }
  if (stdout.includes('Codex auth file: missing')) {
    throw new NonRetryableError('Codex auth file is missing after restore.');
  }
  if (stdout.includes('Codex OPENAI_API_KEY suffix: missing') && stdout.includes('Codex access_token suffix: missing')) {
    throw new NonRetryableError('Codex auth file is present but contains no usable credentials.');
  }
}

async function logCodexCliDiagnostics(
  sandbox: ReturnType<typeof getSandbox>,
  runId: string,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  codexModel: string,
  codexReasoningEffort: string
) {
  const diagnostics = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
command -v codex
codex --version
printf 'Codex model: ${codexModel}\\n'
printf 'Codex reasoning effort: ${codexReasoningEffort}\\n'
`)}`
  );
  await appendCommandLogs(repoBoard, runId, 'codex', diagnostics.stdout, diagnostics.stderr);
  if (!diagnostics.success) {
    throw new NonRetryableError('Codex CLI is not available in the sandbox.');
  }
}

async function persistArtifactManifest(env: Stage3Env, runId: string, manifest: Awaited<ReturnType<RepoBoardDO['getRunArtifacts']>>) {
  if (!manifest || !env.RUN_ARTIFACTS) {
    return;
  }
  await env.RUN_ARTIFACTS.put(`runs/${runId}/manifest.json`, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function failRun(repoBoard: DurableObjectStub<RepoBoardDO>, runId: string, code: string, phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>, error: unknown, retryable = true) {
  const message = error instanceof Error ? error.message : String(error);
  await repoBoard.appendRunLogs(runId, [buildRunLog(runId, message, phase, 'error')]);
  await repoBoard.markRunFailed(runId, {
    at: new Date().toISOString(),
    code,
    message,
    retryable,
    phase
  });
}

async function appendCommandLogs(repoBoard: DurableObjectStub<RepoBoardDO>, runId: string, phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>, stdout?: string, stderr?: string) {
  const logs = [];
  if (stdout?.trim()) logs.push(buildRunLog(runId, stdout.trim(), phase));
  if (stderr?.trim()) logs.push(buildRunLog(runId, stderr.trim(), phase, 'error'));
  if (logs.length) await repoBoard.appendRunLogs(runId, logs);
}

async function execStreamWithLogs(
  sandbox: ReturnType<typeof getSandbox>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>,
  command: string,
  options?: StreamOptions
): Promise<ExecResult> {
  const stdoutBuffer = new LineLogBuffer();
  const stderrBuffer = new LineLogBuffer();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const startedAt = new Date().toISOString();
  let completedAt = Date.now();
  let exitCode = 1;
  let streamError: string | undefined;
  let eventResult: ExecResult | undefined;
  let appendQueue = Promise.resolve();

  const enqueueLogs = (logs: Array<{ message: string; level: 'info' | 'error' }>) => {
    if (!logs.length) {
      return;
    }

    appendQueue = appendQueue.then(() =>
      repoBoard.appendRunLogs(
        runId,
        logs.map((log) => buildRunLog(runId, log.message, phase, log.level))
      )
    );
  };

  const stream = await sandbox.execStream(command, options);

  try {
    for await (const event of parseSSEStream<ExecEvent>(stream)) {
      switch (event.type) {
        case 'stdout': {
          const chunk = event.data ?? '';
          stdoutChunks.push(chunk);
          enqueueLogs(stdoutBuffer.push(chunk).map((message) => ({ message, level: 'info' as const })));
          break;
        }
        case 'stderr': {
          const chunk = event.data ?? '';
          stderrChunks.push(chunk);
          enqueueLogs(stderrBuffer.push(chunk).map((message) => ({ message, level: 'error' as const })));
          break;
        }
        case 'complete':
          completedAt = Date.now();
          exitCode = event.exitCode ?? exitCode;
          eventResult = event.result;
          break;
        case 'error':
          completedAt = Date.now();
          streamError = event.error ?? 'Command stream failed.';
          break;
        case 'start':
          break;
      }
    }
  } finally {
    enqueueLogs(stdoutBuffer.flush().map((message) => ({ message, level: 'info' as const })));
    enqueueLogs(stderrBuffer.flush().map((message) => ({ message, level: 'error' as const })));
    await appendQueue;
  }

  if (eventResult) {
    return eventResult;
  }

  const stdout = stdoutChunks.join('');
  const stderr = [stderrChunks.join(''), streamError].filter(Boolean).join(stderrChunks.length ? '\n' : '');
  return {
    success: !streamError && exitCode === 0,
    exitCode,
    stdout,
    stderr,
    command,
    duration: Math.max(0, completedAt - Date.parse(startedAt)),
    timestamp: startedAt
  };
}

function buildGithubCloneUrl(slug: string, pat: string) {
  return `https://x-access-token:${pat}@github.com/${slug}.git`;
}

function buildCodexPrompt(task: Task, repo: Repo) {
  return [
    `You are working on the Git repository for ${repo.slug}.`,
    '',
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : undefined,
    '',
    'Primary prompt:',
    task.taskPrompt,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    task.context.notes ? `Additional notes: ${task.context.notes}` : undefined,
    ...(task.context.links.length ? ['Context links:', ...task.context.links.map((link) => `- ${link.label}: ${link.url}`)] : []),
    '',
    'Requirements:',
    '- Make the requested code changes in this repository.',
    '- Decide which install/build/test commands are appropriate and run them as needed.',
    '- Do not run `git commit`, `git push`, `git rebase`, or create pull requests. The outer system handles all git history and GitHub operations.',
    '- Leave your code changes uncommitted in the working tree after you finish.',
    '- If no changes are necessary, exit cleanly and let the outer system decide what to do.'
  ].filter(Boolean).join('\n');
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellEscape(value: string) {
  return value.replace(/([^A-Za-z0-9_./:-])/g, '\\$1');
}

function sleep(duration: number | `${number} ${string}`) {
  if (typeof duration === 'number') {
    return new Promise<void>((resolve) => setTimeout(resolve, duration));
  }
  const milliseconds = Number.parseInt(duration, 10) * 1000;
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
