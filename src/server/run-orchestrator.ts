import { getSandbox } from '@cloudflare/sandbox';
import type { RepoBoardDO } from './durable/repo-board';
import type { BoardIndexDO } from './durable/board-index';
import type { Repo, Task } from '../ui/domain/types';
import { buildRunLog, type RunJobParams } from './shared/real-run';
import { NonRetryableError } from 'cloudflare:workflows';

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
    return stage3Env.RUN_WORKFLOW.create({
      id: `${params.mode}:${params.runId}`,
      params,
      retention: { successRetention: '7 days', errorRetention: '14 days' }
    });
  }

  ctx.waitUntil(executeRunJob(env, params, async (_name, duration) => sleep(duration)));
  return { id: `inline:${params.runId}` };
}

export async function executeRunJob(env: Env, params: RunJobParams, sleepFn: SleepFn) {
  const repoBoard = env.REPO_BOARD.getByName(params.repoId) as DurableObjectStub<RepoBoardDO>;
  const board = env.BOARD_INDEX.getByName('agentboard') as DurableObjectStub<BoardIndexDO>;
  const detail = await repoBoard.getTask(params.taskId);
  const run = await repoBoard.getRun(params.runId);
  const repo = await board.getRepo(params.repoId);

  if (params.mode === 'evidence_only') {
    return runEvidence(env as Stage3Env, repoBoard, detail.task, repo, params.runId, sleepFn);
  }

  const pat = await getGithubPat(env as Stage3Env);
  const sandbox = getSandbox(env.Sandbox, params.runId);

  await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `Starting sandbox run for ${repo.slug}.`, 'bootstrap')]);
  await repoBoard.transitionRun(params.runId, { status: 'BOOTSTRAPPING', sandboxId: params.runId, appendTimelineNote: 'Sandbox bootstrapped.' });

  try {
    await sandbox.exec('mkdir -p /workspace/repo');
    await restoreCodexAuth(env as Stage3Env, sandbox, repo, params.runId, repoBoard);
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
    const codexResult = await sandbox.exec("cd /workspace/repo && cat /workspace/task.txt | codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace/repo --json -");
    await appendCommandLogs(repoBoard, params.runId, 'codex', codexResult.stdout, codexResult.stderr);
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
    if (!statusResult.stdout.trim()) {
      await failRun(repoBoard, params.runId, 'NO_CHANGES', 'push', 'Codex finished without producing a diff.', false);
      return;
    }

    const commitMessage = `AgentBoard: ${detail.task.title}`;
    await sandbox.exec(`cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)} && git push origin ${shellEscape(run.branchName)}`);
    const shaResult = await sandbox.exec('cd /workspace/repo && git rev-parse HEAD');
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

  await repoBoard.transitionRun(params.runId, { status: 'WAITING_PREVIEW', previewStatus: 'DISCOVERING', appendTimelineNote: 'Polling GitHub checks for preview URL.' });
  const previewUrl = await waitForPreview(env as Stage3Env, repoBoard, repo, params.runId, sleepFn, pat);
  if (!previewUrl) {
    await failRun(repoBoard, params.runId, 'PREVIEW_TIMEOUT', 'preview', 'Preview URL did not appear before timeout.', false);
    return;
  }

  await repoBoard.transitionRun(params.runId, { previewUrl, previewStatus: 'READY', status: 'EVIDENCE_RUNNING', evidenceStatus: 'RUNNING', appendTimelineNote: 'Running Playwright evidence.' });
  await runEvidence(env as Stage3Env, repoBoard, detail.task, repo, params.runId, sleepFn);
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
    const previewUrl = await lookupPreviewUrl(repo, headSha, pat, repo.previewCheckName);
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, `Preview discovery attempt ${attempt}/${attempts}.`, 'preview', 'info', { headSha })]);
    if (previewUrl) {
      return previewUrl;
    }
    await sleepFn(`preview-${attempt}`, 10_000);
  }

  return undefined;
}

async function lookupPreviewUrl(repo: Repo, headSha: string, pat: string, previewCheckName?: string) {
  const response = await githubRequest(repo.slug, `/commits/${headSha}/check-runs`, pat);
  const payload = await response.json() as { check_runs?: Array<{ name?: string; details_url?: string; html_url?: string }> };
  const candidates = payload.check_runs ?? [];
  const matched = candidates.find((item) => {
    if (previewCheckName && item.name === previewCheckName) return true;
    return Boolean(item.details_url?.includes('pages.dev') || item.html_url?.includes('pages.dev'));
  });
  return matched?.details_url ?? matched?.html_url;
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

async function restoreCodexAuth(env: Stage3Env, sandbox: ReturnType<typeof getSandbox>, repo: Repo, runId: string, repoBoard: DurableObjectStub<RepoBoardDO>) {
  if (!repo.codexAuthBundleR2Key || !env.RUN_ARTIFACTS) {
    return;
  }

  const object = await env.RUN_ARTIFACTS.get(repo.codexAuthBundleR2Key);
  if (!object) {
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, `Codex auth bundle ${repo.codexAuthBundleR2Key} was not found in R2.`, 'bootstrap', 'error')]);
    return;
  }

  await sandbox.writeFile('/workspace/codex-auth.tgz', await object.text());
  await sandbox.exec("mkdir -p ~/.codex && tar -xzf /workspace/codex-auth.tgz -C ~/ || true");
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
    '- Leave the repository in a committed, push-ready state if you make changes.',
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
