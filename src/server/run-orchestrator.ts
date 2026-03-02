import { getSandbox, parseSSEStream, type ExecEvent, type ExecResult, type StreamOptions } from '@cloudflare/sandbox';
import type { RepoBoardDO } from './durable/repo-board';
import type { BoardIndexDO } from './durable/board-index';
import type { Repo, RunCommand, RunCommandPhase, RunEvent, Task } from '../ui/domain/types';
import { buildRunLog, type RunJobParams } from './shared/real-run';
import { NonRetryableError } from 'cloudflare:workflows';
import { inspectPreviewDiscovery } from './preview-discovery';
import { LineLogBuffer } from './line-log-buffer';
import { buildWorkflowInvocationId } from './workflow-id';
import { shouldRunEvidence, shouldRunPreview } from './shared/repo-execution-policy';
import {
  formatCodexRateLimitSnapshot,
  getCodexCapacityDecision,
  type CodexRateLimitsResponse
} from './codex-rate-limit';
import { getRepoHost } from '../shared/scm';
import type { ScmAdapter, ScmAdapterCredential } from './scm/adapter';
import { getScmAdapter } from './scm/registry';

type WorkflowBinding<T> = {
  create(options?: { id?: string; params?: T; retention?: { successRetention?: string | number; errorRetention?: string | number } }): Promise<{ id: string }>;
};

type Stage3Env = Env & {
  RUN_WORKFLOW?: WorkflowBinding<RunJobParams>;
  SECRETS_KV?: KVNamespace;
  RUN_ARTIFACTS?: R2Bucket;
};

type SleepFn = (name: string, duration: number | `${number} ${string}`) => Promise<void>;
type RunPhase = NonNullable<ReturnType<typeof buildRunLog>['phase']>;
const CODEX_STREAM_INACTIVITY_TIMEOUT_MS = 120_000;

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
  if (run.status === 'FAILED' || run.status === 'DONE') {
    return;
  }
  const repo = await board.getRepo(params.repoId);
  const scmAdapter = getScmAdapter(repo);
  const codexModel = detail.task.uiMeta?.codexModel ?? 'gpt-5.1-codex-mini';
  const codexReasoningEffort = detail.task.uiMeta?.codexReasoningEffort ?? 'medium';

  if (params.mode === 'evidence_only') {
    if (!shouldRunEvidence(repo)) {
      await finishRunWithoutEvidence(repoBoard, params.runId, 'Evidence execution is disabled for this repo.');
      return;
    }
    return runEvidence(env as Stage3Env, board, repoBoard, detail.task, repo, params.runId, sleepFn);
  }

  if (params.mode === 'preview_only') {
    if (!shouldRunPreview(repo)) {
      await finishRunWithoutPreview(repoBoard, params.runId, 'Preview discovery is disabled for this repo.');
      return;
    }
    return discoverPreviewAndRunEvidence(
      env as Stage3Env,
      repoBoard,
      detail.task,
      repo,
      params.runId,
      sleepFn,
      scmAdapter,
      await getScmCredential(env as Stage3Env, board, repo, scmAdapter)
    );
  }

  const scmCredential = await getScmCredential(env as Stage3Env, board, repo, scmAdapter);
  const sandbox = getSandbox(env.Sandbox, params.runId);

  await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `Starting sandbox run for ${repo.slug}.`, 'bootstrap')]);
  await repoBoard.transitionRun(params.runId, { status: 'BOOTSTRAPPING', sandboxId: params.runId, appendTimelineNote: 'Sandbox bootstrapped.' });

  try {
    await emitCommandLifecycle(repoBoard, params.runId, 'bootstrap', 'mkdir -p /workspace/repo', () => sandbox.exec('mkdir -p /workspace/repo'));
    await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `${scmAdapter.provider} token suffix: ${scmCredential.token.slice(-4)}`, 'bootstrap')]);
    await restoreCodexAuth(env as Stage3Env, sandbox, repo, params.runId, repoBoard);
    await logCodexAuthDiagnostics(sandbox, params.runId, repoBoard);
    await sandbox.gitCheckout(scmAdapter.buildCloneUrl(repo, scmCredential), {
      branch: repo.defaultBranch,
      targetDir: '/workspace/repo'
    });
    await emitCommandLifecycle(
      repoBoard,
      params.runId,
      'bootstrap',
      `cd /workspace/repo && git config user.name 'AgentsKanban' && git config user.email 'agentskanban@local'`,
      () => sandbox.exec(`cd /workspace/repo && git config user.name 'AgentsKanban' && git config user.email 'agentskanban@local'`)
    );
    await prepareRunBranchFromTaskSource(sandbox, repoBoard, params.runId, detail.task, repo, run, scmAdapter);
  } catch (error) {
    await failRun(repoBoard, params.runId, 'BOOTSTRAP_FAILED', 'bootstrap', error);
    throw error;
  }

  await repoBoard.transitionRun(params.runId, { status: 'RUNNING_CODEX', appendTimelineNote: 'Codex executing with full sandbox permissions.' });

  try {
    const prompt = buildCodexPrompt(detail.task, repo, run);
    await sandbox.writeFile('/workspace/task.txt', prompt);
    await emitCommandLifecycle(
      repoBoard,
      params.runId,
      'codex',
      "bash -lc 'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex'",
      () => sandbox.exec("bash -lc 'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex'")
    );
    await logCodexCliDiagnostics(sandbox, params.runId, repoBoard, codexModel, codexReasoningEffort);
    await waitForCodexCapacityIfNeeded(sandbox, repoBoard, params.runId, codexModel, sleepFn);
    const codexResult = await runCodexProcessWithLogs(
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
    if (codexResult.stoppedForTakeover) {
      await repoBoard.appendRunLogs(params.runId, [
        buildRunLog(params.runId, 'Codex execution stopped after operator takeover. Leaving the sandbox under operator control.', 'codex')
      ]);
      return;
    }
    if (!codexResult.success) {
      throw new NonRetryableError(codexResult.stderr || 'Codex execution failed.');
    }
  } catch (error) {
    const currentRun = await repoBoard.getRun(params.runId);
    if (currentRun.status === 'OPERATOR_CONTROLLED') {
      return;
    }
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
    const branchResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', 'cd /workspace/repo && git branch --show-current', () =>
      sandbox.exec('cd /workspace/repo && git branch --show-current')
    );
    if (!branchResult.success) {
      throw new Error(branchResult.stderr || 'Failed to resolve the current branch.');
    }

    const currentBranch = branchResult.stdout.trim();
    if (currentBranch !== run.branchName) {
      await repoBoard.appendRunLogs(params.runId, [
        buildRunLog(params.runId, `Codex changed the checked out branch to ${currentBranch}. Normalizing push to ${run.branchName} from current HEAD.`, 'push')
      ]);
    }

    const statusResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', 'cd /workspace/repo && git status --short', () =>
      sandbox.exec('cd /workspace/repo && git status --short')
    );
    const hasWorkingTreeChanges = Boolean(statusResult.stdout.trim());
    const baseHeadResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', `cd /workspace/repo && git rev-parse origin/${shellEscape(repo.defaultBranch)}`, () =>
      sandbox.exec(`cd /workspace/repo && git rev-parse origin/${shellEscape(repo.defaultBranch)}`)
    );
    if (!baseHeadResult.success) {
      throw new Error(baseHeadResult.stderr || `Failed to resolve origin/${repo.defaultBranch}.`);
    }

    const currentHeadResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', 'cd /workspace/repo && git rev-parse HEAD', () =>
      sandbox.exec('cd /workspace/repo && git rev-parse HEAD')
    );
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
      commitMessage = `AgentsKanban: ${detail.task.title}`;
      const commitResult = await emitCommandLifecycle(
        repoBoard,
        params.runId,
        'push',
        `cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)} && git push origin HEAD:${shellEscape(run.branchName)}`,
        () => sandbox.exec(`cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)} && git push origin HEAD:${shellEscape(run.branchName)}`)
      );
      if (!commitResult.success) {
        throw new Error(commitResult.stderr || 'Commit and push failed.');
      }
    } else {
      const commitMessageResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', 'cd /workspace/repo && git log -1 --pretty=%s', () =>
        sandbox.exec('cd /workspace/repo && git log -1 --pretty=%s')
      );
      if (!commitMessageResult.success) {
        throw new Error(commitMessageResult.stderr || 'Failed to read the existing commit message.');
      }
      commitMessage = commitMessageResult.stdout.trim() || `AgentsKanban: ${detail.task.title}`;
      await repoBoard.appendRunLogs(params.runId, [
        buildRunLog(params.runId, 'Detected an existing local commit from Codex; pushing it without creating another commit.', 'push')
      ]);
      const pushResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', `cd /workspace/repo && git push origin HEAD:${shellEscape(run.branchName)}`, () =>
        sandbox.exec(`cd /workspace/repo && git push origin HEAD:${shellEscape(run.branchName)}`)
      );
      if (!pushResult.success) {
        throw new Error(pushResult.stderr || 'Push failed.');
      }
    }

    const shaResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', 'cd /workspace/repo && git rev-parse HEAD', () =>
      sandbox.exec('cd /workspace/repo && git rev-parse HEAD')
    );
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
    if (latestRun.prUrl && latestRun.prNumber) {
      await repoBoard.transitionRun(params.runId, {
        status: 'PR_OPEN',
        previewStatus: 'DISCOVERING',
        appendTimelineNote: 'Existing pull request updated with requested changes.'
      });
    } else {
      const pr = await scmAdapter.createReviewRequest(repo, detail.task, latestRun, scmCredential);
      await repoBoard.transitionRun(params.runId, {
        status: 'PR_OPEN',
        prNumber: pr.number,
        prUrl: pr.url,
        previewStatus: 'DISCOVERING',
        appendTimelineNote: 'Pull request opened.'
      });
    }
  } catch (error) {
    await failRun(repoBoard, params.runId, 'PR_CREATE_FAILED', 'pr', error);
    throw error;
  }

  if (!shouldRunPreview(repo)) {
    await finishRunWithoutPreview(repoBoard, params.runId, 'Preview discovery and evidence are disabled for this repo.');
    return;
  }

  await discoverPreviewAndRunEvidence(env as Stage3Env, repoBoard, detail.task, repo, params.runId, sleepFn, scmAdapter, scmCredential);
}

async function runEvidence(
  env: Stage3Env,
  board: DurableObjectStub<BoardIndexDO>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  task: Task,
  repo: Repo,
  runId: string,
  _sleepFn: SleepFn
) {
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
    await emitCommandLifecycle(repoBoard, runId, 'evidence', 'mkdir -p /workspace/evidence', () => sandbox.exec('mkdir -p /workspace/evidence'));
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, 'Installing Playwright Chromium for evidence capture.', 'evidence')]);
    const install = await emitCommandLifecycle(
      repoBoard,
      runId,
      'evidence',
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
npx -y playwright install chromium
`)}`,
      () => sandbox.exec(
        `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
npx -y playwright install chromium
`)}`
      )
    );
    if (!install.success) {
      throw new Error(install.stderr || 'Playwright browser install failed.');
    }
    await emitCommandLifecycle(repoBoard, runId, 'evidence', `npx -y playwright screenshot ${shellEscape(baselineUrl)} /workspace/evidence/before.png`, () =>
      sandbox.exec(`npx -y playwright screenshot ${shellEscape(baselineUrl)} /workspace/evidence/before.png`)
    );
    await emitCommandLifecycle(repoBoard, runId, 'evidence', `npx -y playwright screenshot ${shellEscape(previewUrl)} /workspace/evidence/after.png`, () =>
      sandbox.exec(`npx -y playwright screenshot ${shellEscape(previewUrl)} /workspace/evidence/after.png`)
    );
  } catch (error) {
    await failRun(repoBoard, runId, 'EVIDENCE_FAILED', 'evidence', error);
    return;
  }

  const updated = await repoBoard.storeArtifactManifest(runId);
  await persistArtifactManifest(env, updated.runId, updated.artifactManifest);
  if (updated.prNumber) {
    const scmAdapter = getScmAdapter(repo);
    const scmCredential = await getScmCredential(env, board, repo, scmAdapter);
    await scmAdapter.upsertRunComment(repo, task, updated, scmCredential);
  }
  await repoBoard.transitionRun(runId, { status: 'DONE', evidenceStatus: 'READY', endedAt: new Date().toISOString(), appendTimelineNote: 'Evidence captured and manifest stored.' });
}

async function waitForPreview(
  env: Stage3Env,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  repo: Repo,
  runId: string,
  sleepFn: SleepFn,
  scmAdapter: ScmAdapter,
  scmCredential: ScmAdapterCredential
) {
  const attempts = 12;
  const headSha = (await repoBoard.getRun(runId)).headSha;
  if (!headSha) {
    return undefined;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const discovery = await lookupPreviewUrl(repo, headSha, scmAdapter, scmCredential, repo.previewCheckName);
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
  scmAdapter: ScmAdapter,
  scmCredential: ScmAdapterCredential
) {
  await repoBoard.transitionRun(runId, {
    status: 'WAITING_PREVIEW',
    previewStatus: 'DISCOVERING',
    appendTimelineNote: 'Polling SCM checks for preview URL.'
  });
  const previewUrl = await waitForPreview(env, repoBoard, repo, runId, sleepFn, scmAdapter, scmCredential);
  if (!previewUrl) {
    await failRun(repoBoard, runId, 'PREVIEW_TIMEOUT', 'preview', 'Preview URL did not appear before timeout.', false);
    return;
  }

  await repoBoard.transitionRun(runId, {
    previewUrl,
    previewStatus: 'READY',
    status: shouldRunEvidence(repo) ? 'EVIDENCE_RUNNING' : 'DONE',
    evidenceStatus: shouldRunEvidence(repo) ? 'RUNNING' : 'NOT_STARTED',
    endedAt: shouldRunEvidence(repo) ? undefined : new Date().toISOString(),
    appendTimelineNote: shouldRunEvidence(repo) ? 'Running Playwright evidence.' : 'Preview discovered. Evidence execution is disabled for this repo.'
  });
  if (!shouldRunEvidence(repo)) {
    return;
  }
  await runEvidence(env, env.BOARD_INDEX.getByName('agentboard') as DurableObjectStub<BoardIndexDO>, repoBoard, task, repo, runId, sleepFn);
}

async function finishRunWithoutPreview(repoBoard: DurableObjectStub<RepoBoardDO>, runId: string, note: string) {
  await repoBoard.transitionRun(runId, {
    status: 'DONE',
    previewStatus: 'UNKNOWN',
    evidenceStatus: 'NOT_STARTED',
    endedAt: new Date().toISOString(),
    appendTimelineNote: note
  });
}

async function finishRunWithoutEvidence(repoBoard: DurableObjectStub<RepoBoardDO>, runId: string, note: string) {
  await repoBoard.transitionRun(runId, {
    status: 'DONE',
    evidenceStatus: 'NOT_STARTED',
    endedAt: new Date().toISOString(),
    appendTimelineNote: note
  });
}

async function lookupPreviewUrl(
  repo: Repo,
  headSha: string,
  scmAdapter: ScmAdapter,
  scmCredential: ScmAdapterCredential,
  previewCheckName?: string
) {
  const checks = await scmAdapter.listCommitChecks(repo, headSha, scmCredential);
  return inspectPreviewDiscovery(
    { ...repo, previewCheckName },
    checks.map((check) => ({
      name: check.name,
      details_url: check.detailsUrl,
      html_url: check.htmlUrl,
      output: { summary: check.summary ?? null },
      app: { slug: check.appSlug }
    }))
  );
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

async function getScmCredential(
  env: Stage3Env,
  board: DurableObjectStub<BoardIndexDO>,
  repo: Repo,
  scmAdapter: ScmAdapter
): Promise<ScmAdapterCredential> {
  const registryToken = await board.getScmCredentialSecret(scmAdapter.provider, getRepoHost(repo));
  if (registryToken) {
    return { token: registryToken };
  }

  if (scmAdapter.provider === 'github') {
    const pat = await env.SECRETS_KV?.get('github_pat');
    if (!pat) {
      throw new NonRetryableError('Missing GitHub credential for this host. Configure the SCM credential registry or `github_pat` in KV.');
    }
    return { token: pat };
  }

  throw new NonRetryableError(`Missing SCM credential for provider ${scmAdapter.provider} host ${getRepoHost(repo)}.`);
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
ls -1 "$HOME/.codex" | sort | head -n 40
`)}`
  );
  await appendCommandLogs(repoBoard, runId, 'bootstrap', restoreResult.stdout, restoreResult.stderr);
  if (!restoreResult.success) {
    throw new NonRetryableError('Codex auth bundle restore failed.');
  }

  const mcpConfig = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
CONFIG_DIR="$HOME/.codex"
CONFIG_FILE="$CONFIG_DIR/config.toml"
mkdir -p "$CONFIG_DIR"
touch "$CONFIG_FILE"

if ! grep -Fq "[mcp_servers.cloudflare-doc-mcp]" "$CONFIG_FILE"; then
  printf '\n[mcp_servers.cloudflare-doc-mcp]\nurl="https://docs.mcp.cloudflare.com/mcp"\n' >> "$CONFIG_FILE"
fi

echo "Codex config file: $CONFIG_FILE"
if grep -Fq "[mcp_servers.cloudflare-doc-mcp]" "$CONFIG_FILE"; then
  echo "Cloudflare MCP: configured"
else
  echo "Cloudflare MCP: missing"
fi
`)}`
  );
  await appendCommandLogs(repoBoard, runId, 'bootstrap', mcpConfig.stdout, mcpConfig.stderr);
  if (!mcpConfig.success || !(mcpConfig.stdout ?? '').includes('Cloudflare MCP: configured')) {
    throw new NonRetryableError('Cloudflare MCP configuration failed in sandbox.');
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
const configPath = path.join(codexDir, 'config.toml');
console.log(\`Codex config file: \${configPath}\`);
if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
  const config = fs.readFileSync(configPath, 'utf8');
  console.log(\`Cloudflare MCP configured: \${config.includes('[mcp_servers.cloudflare-doc-mcp]') ? 'yes' : 'no'}\`);
} else {
  console.log('Cloudflare MCP configured: no');
}
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
  if (stdout.includes('Cloudflare MCP configured: no')) {
    throw new NonRetryableError('Cloudflare MCP is not configured in sandbox codex config.');
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

async function waitForCodexCapacityIfNeeded(
  sandbox: ReturnType<typeof getSandbox>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  codexModel: string,
  sleepFn: SleepFn
) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const payload = await readCodexRateLimits(sandbox, repoBoard, runId);
    if (!payload) {
      return;
    }

    const decision = getCodexCapacityDecision(payload, codexModel, Date.now());
    if (!decision.snapshot) {
      await repoBoard.appendRunLogs(runId, [
        buildRunLog(runId, 'Codex usage preflight did not return a usable rate-limit snapshot. Continuing without waiting.', 'codex')
      ]);
      return;
    }

    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, formatCodexRateLimitSnapshot(decision.snapshot), 'codex')
    ]);

    if (!decision.shouldWait || !decision.waitMs) {
      return;
    }

    await repoBoard.transitionRun(runId, {
      status: 'BOOTSTRAPPING',
      appendTimelineNote: 'Waiting for Codex rate limits to reset before starting execution.'
    });
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, `${decision.reason} Sleeping until Codex budget resets.`, 'codex', 'error')
    ]);
    await sleepFn(`codex-budget-${attempt}`, Math.max(1_000, decision.waitMs));
    await repoBoard.transitionRun(runId, {
      status: 'RUNNING_CODEX',
      appendTimelineNote: 'Codex rate-limit wait completed. Rechecking execution budget.'
    });
  }
}

async function readCodexRateLimits(
  sandbox: ReturnType<typeof getSandbox>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string
): Promise<CodexRateLimitsResponse | undefined> {
  await sandbox.writeFile(
    '/workspace/codex-rate-limits.mjs',
    `import { spawn } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const child = spawn('codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdoutBuffer = '';
let stderrBuffer = '';
let resolved = false;

const timeout = setTimeout(() => {
  if (!resolved) {
    child.kill('SIGTERM');
    fail('Timed out while reading Codex rate limits.');
  }
}, 10000);

child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf('\\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' }) + '\\n');
      continue;
    }
    if (message.id === 2) {
      resolved = true;
      clearTimeout(timeout);
      console.log(JSON.stringify(message.result));
      child.kill('SIGTERM');
      return;
    }
  }
});

child.on('exit', (code) => {
  if (resolved) {
    return;
  }
  clearTimeout(timeout);
  fail(stderrBuffer.trim() || \`Codex app-server exited before returning rate limits (code \${code ?? 'unknown'}).\`);
});

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    apiVersion: 2,
    clientInfo: { name: 'agentboard-rate-limit-probe', version: '1.0.0' }
  }
}) + '\\n');
`
  );
  const result = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
node /workspace/codex-rate-limits.mjs
`)}`
  );
  if (!result.success) {
    await appendCommandLogs(repoBoard, runId, 'codex', result.stdout, result.stderr);
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, 'Codex usage preflight failed. Continuing without a rate-limit wait.', 'codex', 'error')
    ]);
    return undefined;
  }

  try {
    return JSON.parse(result.stdout.trim()) as CodexRateLimitsResponse;
  } catch (error) {
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(
        runId,
        `Codex usage preflight returned invalid JSON (${error instanceof Error ? error.message : String(error)}). Continuing without a rate-limit wait.`,
        'codex',
        'error'
      )
    ]);
    return undefined;
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

async function emitCommandLifecycle(
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  phase: RunPhase,
  command: string,
  execute: () => Promise<ExecResult>
) {
  const run = await repoBoard.getRun(runId);
  const commandId = buildRunCommandId(runId, phase);
  const startedAt = new Date().toISOString();
  const startedCommand: RunCommand = {
    id: commandId,
    runId,
    phase: phase as RunCommandPhase,
    startedAt,
    status: 'running',
    command,
    source: 'system'
  };
  await repoBoard.upsertRunCommands(runId, [startedCommand]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(run, 'workflow', 'command.started', `Started ${phase} command.`, { commandId, phase })
  ]);

  const result = await execute();
  const completedRun = await repoBoard.getRun(runId);
  const stdoutPreview = summarizeOutput(result.stdout);
  const stderrPreview = summarizeOutput(result.stderr);
  const completedCommand: RunCommand = {
    ...startedCommand,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    status: result.success ? 'completed' : 'failed',
    stdoutPreview,
    stderrPreview
  };
  await repoBoard.upsertRunCommands(runId, [completedCommand]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(
      completedRun,
      result.success ? 'workflow' : 'system',
      'command.completed',
      `Completed ${phase} command with exit code ${result.exitCode}.`,
      { commandId, phase, exitCode: result.exitCode, success: result.success }
    )
  ]);

  return result;
}

async function execStreamWithLogs(
  sandbox: ReturnType<typeof getSandbox>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>,
  command: string,
  options?: StreamOptions
): Promise<ExecResult> {
  const commandId = buildRunCommandId(runId, phase);
  const run = await repoBoard.getRun(runId);
  const startedAt = new Date().toISOString();
  const stdoutBuffer = new LineLogBuffer();
  const stderrBuffer = new LineLogBuffer();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let completedAt = Date.now();
  let exitCode = 1;
  let streamError: string | undefined;
  let eventResult: ExecResult | undefined;
  let appendQueue = Promise.resolve();
  let latestResumeCommand: string | undefined;
  let latestThreadId: string | undefined;

  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase: phase as RunCommandPhase,
    startedAt,
    status: 'running',
    command,
    source: 'system'
  }]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(run, 'workflow', 'command.started', `Started ${phase} command.`, { commandId, phase })
  ]);

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
          const resumeMatch = extractCodexResumeState(chunk, latestThreadId);
          latestThreadId = resumeMatch.threadId ?? latestThreadId;
          if (resumeMatch.resumeCommand && resumeMatch.resumeCommand !== latestResumeCommand) {
            latestResumeCommand = resumeMatch.resumeCommand;
            const latestRun = await repoBoard.getRun(runId);
            await repoBoard.transitionRun(runId, { latestCodexResumeCommand: latestResumeCommand });
            if (latestRun.operatorSession) {
              await repoBoard.updateOperatorSession(runId, {
                ...latestRun.operatorSession,
                codexResumeCommand: latestResumeCommand,
                codexThreadId: latestThreadId,
                takeoverState: latestRun.operatorSession.takeoverState === 'operator_control' ? 'resumable' : latestRun.operatorSession.takeoverState
              });
            }
            await repoBoard.appendRunEvents(runId, [
              buildRunEvent(
                await repoBoard.getRun(runId),
                'system',
                'codex.resume_available',
                'Codex resume command is available for this run.',
                { command: latestResumeCommand }
              )
            ]);
          }
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
    await repoBoard.upsertRunCommands(runId, [{
      id: commandId,
      runId,
      phase: phase as RunCommandPhase,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: eventResult.exitCode,
      status: eventResult.success ? 'completed' : 'failed',
      command,
      source: 'system',
      stdoutPreview: summarizeOutput(eventResult.stdout),
      stderrPreview: summarizeOutput(eventResult.stderr)
    }]);
    await repoBoard.appendRunEvents(runId, [
      buildRunEvent(await repoBoard.getRun(runId), eventResult.success ? 'workflow' : 'system', 'command.completed', `Completed ${phase} command with exit code ${eventResult.exitCode}.`, {
        commandId,
        phase,
        exitCode: eventResult.exitCode,
        success: eventResult.success
      })
    ]);
    return eventResult;
  }

  const stdout = stdoutChunks.join('');
  const stderr = [stderrChunks.join(''), streamError].filter(Boolean).join(stderrChunks.length ? '\n' : '');
  const result = {
    success: !streamError && exitCode === 0,
    exitCode,
    stdout,
    stderr,
    command,
    duration: Math.max(0, completedAt - Date.parse(startedAt)),
    timestamp: startedAt
  };
  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase: phase as RunCommandPhase,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    status: result.success ? 'completed' : 'failed',
    command,
    source: 'system',
    stdoutPreview: summarizeOutput(result.stdout),
    stderrPreview: summarizeOutput(result.stderr)
  }]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(await repoBoard.getRun(runId), result.success ? 'workflow' : 'system', 'command.completed', `Completed ${phase} command with exit code ${result.exitCode}.`, {
      commandId,
      phase,
      exitCode: result.exitCode,
      success: result.success
    })
  ]);
  return result;
}

type ManagedExecResult = ExecResult & { stoppedForTakeover?: boolean };

async function runCodexProcessWithLogs(
  sandbox: ReturnType<typeof getSandbox>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>,
  command: string
): Promise<ManagedExecResult> {
  const commandId = buildRunCommandId(runId, phase);
  const run = await repoBoard.getRun(runId);
  const startedAt = new Date().toISOString();
  const stdoutBuffer = new LineLogBuffer();
  const stderrBuffer = new LineLogBuffer();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let completedAt = Date.now();
  let exitCode = 1;
  let streamError: string | undefined;
  let appendQueue = Promise.resolve();
  let latestResumeCommand: string | undefined;
  let latestThreadId: string | undefined;
  let lastStreamEventAt = Date.now();

  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase: phase as RunCommandPhase,
    startedAt,
    status: 'running',
    command,
    source: 'system'
  }]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(run, 'workflow', 'command.started', `Started ${phase} command.`, { commandId, phase })
  ]);

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

  const process = await sandbox.startProcess(command);
  await repoBoard.transitionRun(runId, { codexProcessId: process.id });
  const stream = await sandbox.streamProcessLogs(process.id);
  const iterator = parseSSEStream<Record<string, unknown>>(stream)[Symbol.asyncIterator]();

  try {
    while (true) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<Record<string, unknown>>>((_, reject) =>
          setTimeout(() => reject(new Error('CODEX_STREAM_IDLE_TIMEOUT')), CODEX_STREAM_INACTIVITY_TIMEOUT_MS)
        )
      ]);
      if (next.done) {
        break;
      }
      const event = next.value;
      lastStreamEventAt = Date.now();
      const eventType = typeof event.type === 'string' ? event.type : '';
      switch (eventType) {
        case 'stdout': {
          const chunk = typeof event.data === 'string' ? event.data : '';
          stdoutChunks.push(chunk);
          const resumeMatch = extractCodexResumeState(chunk, latestThreadId);
          latestThreadId = resumeMatch.threadId ?? latestThreadId;
          if (resumeMatch.resumeCommand && resumeMatch.resumeCommand !== latestResumeCommand) {
            latestResumeCommand = resumeMatch.resumeCommand;
            const latestRun = await repoBoard.getRun(runId);
            await repoBoard.transitionRun(runId, { latestCodexResumeCommand: latestResumeCommand });
            if (latestRun.operatorSession) {
              await repoBoard.updateOperatorSession(runId, {
                ...latestRun.operatorSession,
                codexResumeCommand: latestResumeCommand,
                codexThreadId: latestThreadId,
                takeoverState: latestRun.operatorSession.takeoverState === 'operator_control' ? 'resumable' : latestRun.operatorSession.takeoverState
              });
            }
            await repoBoard.appendRunEvents(runId, [
              buildRunEvent(
                await repoBoard.getRun(runId),
                'system',
                'codex.resume_available',
                'Codex resume command is available for this run.',
                { command: latestResumeCommand }
              )
            ]);
          }
          enqueueLogs(stdoutBuffer.push(chunk).map((message) => ({ message, level: 'info' as const })));
          break;
        }
        case 'stderr': {
          const chunk = typeof event.data === 'string' ? event.data : '';
          stderrChunks.push(chunk);
          enqueueLogs(stderrBuffer.push(chunk).map((message) => ({ message, level: 'error' as const })));
          break;
        }
        case 'exit':
        case 'complete':
          completedAt = Date.now();
          exitCode = typeof event.exitCode === 'number' ? event.exitCode : exitCode;
          break;
        case 'error':
          completedAt = Date.now();
          streamError = typeof event.error === 'string' ? event.error : 'Command stream failed.';
          break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CODEX_STREAM_IDLE_TIMEOUT') {
      const idleMs = Date.now() - lastStreamEventAt;
      streamError = `Codex stream inactivity timeout after ${Math.floor(idleMs / 1000)}s without events.`;
      try {
        await sandbox.killProcess(process.id);
      } catch {
        // best effort
      }
      await repoBoard.appendRunLogs(runId, [
        buildRunLog(runId, `${streamError} Killed Codex process and failing run for retry.`, phase, 'error')
      ]);
    } else {
      throw error;
    }
  } finally {
    enqueueLogs(stdoutBuffer.flush().map((message) => ({ message, level: 'info' as const })));
    enqueueLogs(stderrBuffer.flush().map((message) => ({ message, level: 'error' as const })));
    await appendQueue;
  }

  const latestRun = await repoBoard.getRun(runId);
  const stoppedForTakeover = latestRun.status === 'OPERATOR_CONTROLLED';
  const stdout = stdoutChunks.join('');
  const stderr = [stderrChunks.join(''), streamError].filter(Boolean).join(stderrChunks.length ? '\n' : '');
  const result: ManagedExecResult = {
    success: !streamError && exitCode === 0,
    exitCode,
    stdout,
    stderr,
    command,
    duration: Math.max(0, completedAt - Date.parse(startedAt)),
    timestamp: startedAt,
    stoppedForTakeover
  };

  await repoBoard.transitionRun(runId, { codexProcessId: undefined });
  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase: phase as RunCommandPhase,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    status: result.success || stoppedForTakeover ? 'completed' : 'failed',
    command,
    source: 'system',
    stdoutPreview: summarizeOutput(result.stdout),
    stderrPreview: summarizeOutput(result.stderr)
  }]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(
      await repoBoard.getRun(runId),
      stoppedForTakeover ? 'operator' : result.success ? 'workflow' : 'system',
      'command.completed',
      stoppedForTakeover
        ? `Stopped ${phase} command after operator takeover.`
        : `Completed ${phase} command with exit code ${result.exitCode}.`,
      {
        commandId,
        phase,
        exitCode: result.exitCode,
        success: result.success,
        stoppedForTakeover
      }
    )
  ]);
  return result;
}

function buildCodexPrompt(task: Task, repo: Repo, run: Awaited<ReturnType<RepoBoardDO['getRun']>>) {
  return [
    `You are working on the Git repository for ${repo.slug}.`,
    '',
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : undefined,
    run.changeRequest?.prompt ? '' : undefined,
    run.changeRequest?.prompt ? 'Review change request:' : undefined,
    run.changeRequest?.prompt ?? undefined,
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
    run.changeRequest?.prompt
      ? `- The outer system already prepared the existing PR branch ${run.branchName} for this change request. Update that branch in place and keep the existing PR alive.`
      : task.sourceRef
        ? `- The outer system already prepared the run branch from this task source ref: ${task.sourceRef}. Do not fetch or checkout another starting branch yourself.`
        : undefined,
    '- Do not run `git commit`, `git push`, `git rebase`, or create pull requests. The outer system handles all git history and GitHub operations.',
    '- Do not switch git branches or change git remotes. Stay on the branch the outer system prepared for you.',
    '- Leave your code changes uncommitted in the working tree after you finish.',
    '- If no changes are necessary, exit cleanly and let the outer system decide what to do.'
  ].filter(Boolean).join('\n');
}

async function prepareRunBranchFromTaskSource(
  sandbox: ReturnType<typeof getSandbox>,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  task: Task,
  repo: Repo,
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>,
  scmAdapter: ScmAdapter
) {
  if (run.changeRequest?.prompt && run.prUrl) {
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, `Preparing existing PR branch ${run.branchName} for a review change request.`, 'bootstrap')
    ]);
    const checkout = await sandbox.exec(
      `cd /workspace/repo && git fetch origin ${shellEscape(run.branchName)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`
    );
    await appendCommandLogs(repoBoard, runId, 'bootstrap', checkout.stdout, checkout.stderr);
    if (!checkout.success) {
      throw new Error(checkout.stderr || `Failed to prepare existing PR branch ${run.branchName}.`);
    }
    return;
  }

  if (task.branchSource?.kind === 'dependency_review_head') {
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(
        runId,
        `Preparing run branch ${run.branchName} from upstream review head ${task.branchSource.upstreamHeadSha?.slice(0, 12) ?? task.branchSource.resolvedRef}.`,
        'bootstrap'
      )
    ]);
    const checkout = await sandbox.exec(
      `cd /workspace/repo && git fetch origin ${shellEscape(task.branchSource.resolvedRef)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`
    );
    await appendCommandLogs(repoBoard, runId, 'bootstrap', checkout.stdout, checkout.stderr);
    if (!checkout.success) {
      throw new Error(checkout.stderr || `Failed to prepare run branch ${run.branchName} from upstream review head.`);
    }
    return;
  }

  if (task.branchSource?.kind === 'default_branch') {
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, `Preparing run branch ${run.branchName} from default branch ${repo.defaultBranch}.`, 'bootstrap')
    ]);
    const checkout = await sandbox.exec(
      `cd /workspace/repo && git fetch origin ${shellEscape(repo.defaultBranch)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`
    );
    await appendCommandLogs(repoBoard, runId, 'bootstrap', checkout.stdout, checkout.stderr);
    if (!checkout.success) {
      throw new Error(checkout.stderr || `Failed to prepare run branch ${run.branchName} from default branch ${repo.defaultBranch}.`);
    }
    return;
  }

  const explicitSourceRef = task.branchSource?.kind === 'explicit_source_ref'
    ? task.branchSource.resolvedRef
    : scmAdapter.inferSourceRefFromTask(task, repo);
  if (!explicitSourceRef) {
    const checkout = await sandbox.exec(`cd /workspace/repo && git checkout -b ${shellEscape(run.branchName)}`);
    await appendCommandLogs(repoBoard, runId, 'bootstrap', checkout.stdout, checkout.stderr);
    if (!checkout.success) {
      throw new Error(checkout.stderr || `Failed to create run branch ${run.branchName}.`);
    }
    return;
  }

  const normalized = scmAdapter.normalizeSourceRef(explicitSourceRef, repo);
  await repoBoard.appendRunLogs(runId, [
    buildRunLog(runId, `Preparing run branch ${run.branchName} from explicit source ref ${normalized.label}.`, 'bootstrap')
  ]);
  const checkout = await sandbox.exec(
    `cd /workspace/repo && git fetch origin ${shellEscape(normalized.fetchSpec)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`
  );
  await appendCommandLogs(repoBoard, runId, 'bootstrap', checkout.stdout, checkout.stderr);
  if (!checkout.success) {
    throw new Error(checkout.stderr || `Failed to prepare run branch ${run.branchName} from ${normalized.label}.`);
  }
}

function buildRunCommandId(runId: string, phase: RunPhase) {
  return `${runId}_${phase}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildRunEvent(
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>,
  actorType: RunEvent['actorType'],
  eventType: RunEvent['eventType'],
  message: string,
  metadata?: Record<string, string | number | boolean>
): RunEvent {
  const at = new Date().toISOString();
  return {
    id: `${run.runId}_${eventType}_${at}_${Math.random().toString(36).slice(2, 8)}`,
    runId: run.runId,
    repoId: run.repoId,
    taskId: run.taskId,
    at,
    actorType,
    eventType,
    message,
    metadata
  };
}

function summarizeOutput(output?: string) {
  if (!output?.trim()) {
    return undefined;
  }

  const compact = output.trim().replace(/\s+/g, ' ');
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function extractCodexResumeState(chunk: string, fallbackThreadId?: string) {
  const threadMatch = chunk.match(/"thread_id":"([^"]+)"/);
  const threadId = threadMatch?.[1] ?? fallbackThreadId;
  const resumeMatch = chunk.match(/codex resume ([a-z0-9-]+)/i);
  const resumeCommand = resumeMatch?.[1]
    ? `codex resume ${resumeMatch[1]}`
    : threadId
      ? undefined
      : undefined;

  return { threadId, resumeCommand };
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
