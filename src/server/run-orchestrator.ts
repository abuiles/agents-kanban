import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { RepoBoardDO } from './durable/repo-board';
import type { BoardIndexDO } from './durable/board-index';
import type { LlmReasoningEffort, Repo, RunCommand, RunCommandPhase, RunEvent, Task } from '../ui/domain/types';
import { buildRunLog, type RunJobParams } from './shared/real-run';
import { NonRetryableError } from 'cloudflare:workflows';
import { buildWorkflowInvocationId } from './workflow-id';
import { shouldRunEvidence, shouldRunPreview } from './shared/repo-execution-policy';
import { getRepoHost } from '../shared/scm';
import { getRunReviewNumber, getRunReviewUrl } from '../shared/scm';
import type { ScmAdapter, ScmAdapterCredential } from './scm/adapter';
import { getScmAdapter } from './scm/registry';
import { getScmSourceRefFetchSpec } from './scm/source-ref';
import { getLlmAdapter, resolveLlmAdapterKind } from './llm/registry';
import { getPreviewAdapter } from './preview/registry';
import type { PreviewAdapterContext, PreviewAdapterResult } from './preview/adapter';
import { writeUsageLedgerEntriesBestEffort } from './usage-ledger';
import { normalizeTenantId } from '../shared/tenant';

type WorkflowBinding<T> = {
  create(options?: { id?: string; params?: T; retention?: { successRetention?: string | number; errorRetention?: string | number } }): Promise<{ id: string }>;
};

type Stage3Env = Env & {
  RUN_WORKFLOW?: WorkflowBinding<RunJobParams>;
  RUN_ARTIFACTS?: R2Bucket;
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  OPENAI_API_KEY?: string;
};

type SleepFn = (name: string, duration: number | `${number} ${string}`) => Promise<void>;
type RunPhase = NonNullable<ReturnType<typeof buildRunLog>['phase']>;

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
  const llmAdapterKind = resolveLlmAdapterKind(detail.task, run.llmAdapter);
  const llmAdapter = getLlmAdapter(llmAdapterKind);
  const llmExecutorLabel = llmAdapter.kind === 'codex' ? 'Codex' : 'Cursor CLI';
  const llmModel = detail.task.uiMeta?.llmModel ?? detail.task.uiMeta?.codexModel ?? 'gpt-5.1-codex-mini';
  const llmReasoningEffort = detail.task.uiMeta?.llmReasoningEffort ?? detail.task.uiMeta?.codexReasoningEffort ?? 'medium';
  const workflowStartedAtMs = Date.now();
  let sandboxStartedAtMs: number | undefined;
  const emitUsage = async (
    entries: Array<{
      category: import('./usage-ledger').UsageLedgerCategory;
      quantity: number;
      unit?: string;
      source: import('./usage-ledger').UsageLedgerSource;
      metadata?: Record<string, string | number | boolean>;
    }>
  ) => {
    await writeUsageLedgerEntriesBestEffort(
      env,
      entries.map((entry) => ({
        tenantId: normalizeTenantId(run.tenantId),
        repoId: run.repoId,
        taskId: run.taskId,
        runId: run.runId,
        ...entry
      }))
    );
  };

  try {
    await emitUsage([
      {
        category: 'workflow_execution',
        quantity: 1,
        source: 'workflow',
        metadata: { mode: params.mode, event: 'workflow_started' }
      },
      {
        category: 'workflow_step',
        quantity: 1,
        source: 'workflow',
        metadata: { mode: params.mode, step: 'run_entered' }
      }
    ]);

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
      const promptRecipeRuntime = repo.previewAdapter === 'prompt_recipe'
        ? createPromptRecipeRuntime(env as Stage3Env, repoBoard, params.runId, repo, llmAdapter, llmModel, llmReasoningEffort)
        : undefined;
      return discoverPreviewAndRunEvidence(
        env as Stage3Env,
        repoBoard,
        detail.task,
        repo,
        params.runId,
        sleepFn,
        scmAdapter,
        await getScmCredential(env as Stage3Env, repo, scmAdapter),
        promptRecipeRuntime
      );
    }

    const scmCredential = await getScmCredential(env as Stage3Env, repo, scmAdapter);
    const sandbox = getSandbox(env.Sandbox, params.runId);
    const llmContext = { env, sandbox, repoBoard, runId: params.runId };
    sandboxStartedAtMs = Date.now();

    await emitUsage([
      {
        category: 'workflow_step',
        quantity: 1,
        source: 'workflow',
        metadata: { step: 'sandbox_allocated' }
      }
    ]);

    await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `Starting sandbox run for ${repo.slug}.`, 'bootstrap')]);
    await repoBoard.transitionRun(params.runId, {
      status: 'BOOTSTRAPPING',
      sandboxId: params.runId,
      llmAdapter: llmAdapter.kind,
      llmSupportsResume: llmAdapter.capabilities.supportsResume,
      appendTimelineNote: 'Sandbox bootstrapped.'
    });

    try {
      await emitCommandLifecycle(repoBoard, params.runId, 'bootstrap', 'mkdir -p /workspace/repo', () => sandbox.exec('mkdir -p /workspace/repo'));
      await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `${scmAdapter.provider} token suffix: ${scmCredential.token.slice(-4)}`, 'bootstrap')]);
      await configureSandboxRuntimeSecrets(sandbox, env as Stage3Env);
      await llmAdapter.restoreAuth({ ...llmContext, repo });
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

    await repoBoard.transitionRun(params.runId, { status: 'RUNNING_CODEX', appendTimelineNote: `${llmExecutorLabel} executing with full sandbox permissions.` });

    try {
      const prompt = buildLlmPrompt(detail.task, repo, run);
      const request = {
        repo,
        task: detail.task,
        run,
        cwd: '/workspace/repo',
        prompt,
        model: llmModel,
        reasoningEffort: llmReasoningEffort
      } as const;
      await llmAdapter.ensureInstalled(llmContext);
      await llmAdapter.logDiagnostics(llmContext, request);
      await llmAdapter.waitForCapacityIfNeeded?.(llmContext, request, sleepFn);
      const llmResult = await llmAdapter.run(llmContext, request);
      if (llmResult.stoppedForTakeover) {
        await repoBoard.appendRunLogs(params.runId, [
          buildRunLog(params.runId, `${llmExecutorLabel} execution stopped after operator takeover. Leaving the sandbox under operator control.`, 'codex')
        ]);
        return;
      }
      if (!llmResult.success) {
        throw new NonRetryableError(llmResult.stderr || `${llmExecutorLabel} execution failed.`);
      }
    } catch (error) {
      const currentRun = await repoBoard.getRun(params.runId);
      if (currentRun.status === 'OPERATOR_CONTROLLED') {
        return;
      }
      await failRun(repoBoard, params.runId, 'LLM_FAILED', 'codex', error, false);
      throw error;
    }

    await repoBoard.transitionRun(params.runId, {
      status: 'RUNNING_TESTS',
      appendTimelineNote: `${llmExecutorLabel}-selected validation commands executed inside the sandbox.`,
      executionSummary: { testsOutcome: 'skipped' }
    });
    await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `${llmExecutorLabel} was responsible for choosing and running validation commands.`, 'tests')]);

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
          buildRunLog(params.runId, `${llmExecutorLabel} changed the checked out branch to ${currentBranch}. Normalizing push to ${run.branchName} from current HEAD.`, 'push')
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
        await failRun(repoBoard, params.runId, 'NO_CHANGES', 'push', `${llmExecutorLabel} finished without producing a diff.`, false);
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
          buildRunLog(params.runId, `Detected an existing local commit from ${llmExecutorLabel}; pushing it without creating another commit.`, 'push')
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
      if (getRunReviewUrl(latestRun) && getRunReviewNumber(latestRun)) {
        await repoBoard.transitionRun(params.runId, {
          status: 'PR_OPEN',
          reviewState: 'open',
          landedOnDefaultBranch: false,
          landedOnDefaultBranchAt: undefined,
          previewStatus: 'DISCOVERING',
          appendTimelineNote: 'Existing pull request updated with requested changes.'
        });
      } else {
        const pr = await scmAdapter.createReviewRequest(repo, detail.task, latestRun, scmCredential);
        await repoBoard.transitionRun(params.runId, {
          status: 'PR_OPEN',
          reviewUrl: pr.url,
          reviewNumber: pr.number,
          reviewProvider: pr.provider,
          reviewState: 'open',
          prNumber: pr.number,
          prUrl: pr.url,
          landedOnDefaultBranch: false,
          landedOnDefaultBranchAt: undefined,
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

    const promptRecipeRuntime = repo.previewAdapter === 'prompt_recipe'
      ? createPromptRecipeRuntime(env as Stage3Env, repoBoard, params.runId, repo, llmAdapter, llmModel, llmReasoningEffort)
      : undefined;

    await discoverPreviewAndRunEvidence(
      env as Stage3Env,
      repoBoard,
      detail.task,
      repo,
      params.runId,
      sleepFn,
      scmAdapter,
      scmCredential,
      promptRecipeRuntime
    );
  } finally {
    const endedAtMs = Date.now();
    await emitUsage([
      {
        category: 'workflow_duration_ms',
        quantity: Math.max(0, endedAtMs - workflowStartedAtMs),
        source: 'workflow',
        metadata: { mode: params.mode }
      }
    ]);
    if (sandboxStartedAtMs !== undefined) {
      await emitUsage([
        {
          category: 'sandbox_runtime_ms',
          quantity: Math.max(0, endedAtMs - sandboxStartedAtMs),
          source: 'sandbox',
          metadata: { sandboxId: params.runId }
        }
      ]);
    }
  }
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
  await persistArtifactManifest(env, updated);
  if (getRunReviewNumber(updated)) {
    const scmAdapter = getScmAdapter(repo);
    const scmCredential = await getScmCredential(env, repo, scmAdapter);
    await scmAdapter.upsertRunComment(repo, task, updated, scmCredential);
  }
  await repoBoard.transitionRun(runId, { status: 'DONE', evidenceStatus: 'READY', endedAt: new Date().toISOString(), appendTimelineNote: 'Evidence captured and manifest stored.' });
}

async function waitForPreview(
  repoBoard: DurableObjectStub<RepoBoardDO>,
  task: Task,
  repo: Repo,
  runId: string,
  sleepFn: SleepFn,
  scmAdapter: ScmAdapter,
  scmCredential: ScmAdapterCredential,
  promptRecipeRuntime?: PreviewAdapterContext['promptRecipeRuntime']
) {
  const attempts = 12;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const run = await repoBoard.getRun(runId);
    const headSha = run.headSha;
    if (!headSha) {
      return { status: 'failed' as const, reason: 'missing_head_sha' as const };
    }

    const discovery = await lookupPreviewUrl(repo, task, run, headSha, scmAdapter, scmCredential, promptRecipeRuntime);
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, `Preview discovery attempt ${attempt}/${attempts}.`, 'preview', 'info', { headSha }),
      buildRunLog(
        runId,
        formatPreviewDiscoveryLog(discovery),
        'preview',
        discovery.resolution.status === 'ready' ? 'info' : discovery.resolution.status === 'pending' ? 'info' : 'error',
        {
          headSha,
          adapter: discovery.resolution.adapter,
          resolutionStatus: discovery.resolution.status,
          matchedCheck: discovery.compatibility.matchedCheck ?? 'none',
          source: discovery.compatibility.source ?? 'none',
          checkCount: discovery.compatibility.checks.length
        }
      )
    ]);
    if (discovery.resolution.status === 'ready' && discovery.resolution.previewUrl) {
      return { status: 'ready' as const, previewUrl: discovery.resolution.previewUrl };
    }
    if (discovery.resolution.status === 'failed' || discovery.resolution.status === 'timed_out') {
      return { status: discovery.resolution.status, resolution: discovery.resolution } as const;
    }
    await sleepFn(`preview-${attempt}`, 10_000);
  }

  return { status: 'timed_out' as const };
}

async function discoverPreviewAndRunEvidence(
  env: Stage3Env,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  task: Task,
  repo: Repo,
  runId: string,
  sleepFn: SleepFn,
  scmAdapter: ScmAdapter,
  scmCredential: ScmAdapterCredential,
  promptRecipeRuntime?: PreviewAdapterContext['promptRecipeRuntime']
) {
  await repoBoard.transitionRun(runId, {
    status: 'WAITING_PREVIEW',
    previewStatus: 'DISCOVERING',
    appendTimelineNote: 'Polling SCM checks for preview URL.'
  });
  const preview = await waitForPreview(repoBoard, task, repo, runId, sleepFn, scmAdapter, scmCredential, promptRecipeRuntime);
  if (preview.status !== 'ready') {
    const timeoutMessage = preview.status === 'timed_out'
      ? 'Preview URL did not appear before timeout. Completing run without preview evidence.'
      : preview.status === 'failed' && preview.reason === 'missing_head_sha'
        ? 'Preview discovery could not start because the run head SHA is missing.'
        : preview.resolution?.explanation ?? 'Preview discovery failed before a usable preview URL was produced.';
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, timeoutMessage, 'preview', 'error')
    ]);
    await repoBoard.transitionRun(runId, {
      status: 'DONE',
      previewStatus: 'FAILED',
      evidenceStatus: 'NOT_STARTED',
      endedAt: new Date().toISOString(),
      appendTimelineNote: preview.status === 'timed_out'
        ? 'Preview URL was not discovered before timeout. Run completed without preview evidence.'
        : 'Preview resolution failed. Run completed without preview evidence.'
    });
    return;
  }

  await repoBoard.transitionRun(runId, {
    previewUrl: preview.previewUrl,
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
  task: Task,
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>,
  headSha: string,
  scmAdapter: ScmAdapter,
  scmCredential: ScmAdapterCredential,
  promptRecipeRuntime?: PreviewAdapterContext['promptRecipeRuntime']
) {
  const checks = await scmAdapter.listCommitChecks(repo, headSha, scmCredential);
  const previewAdapter = getPreviewAdapter(repo);
  return previewAdapter.resolve({
    repo,
    task,
    run,
    checks,
    promptRecipeRuntime
  });
}

function createPromptRecipeRuntime(
  env: Stage3Env,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  runId: string,
  repo: Repo,
  llmAdapter: ReturnType<typeof getLlmAdapter>,
  model: string,
  reasoningEffort: LlmReasoningEffort
): PreviewAdapterContext['promptRecipeRuntime'] {
  const sandbox = getSandbox(env.Sandbox, `${runId}-preview`);
  const llmContext = { env, sandbox, repoBoard, runId };
  let prepared = false;

  return {
    cwd: '/workspace/preview',
    model,
    reasoningEffort,
    async execute(request, timeoutMs) {
      const startedAt = Date.now();

      if (!prepared) {
        await emitCommandLifecycle(repoBoard, runId, 'preview', 'mkdir -p /workspace/preview', () => sandbox.exec('mkdir -p /workspace/preview'));
        await configureSandboxRuntimeSecrets(sandbox, env);
        await llmAdapter.restoreAuth({ ...llmContext, repo });
        await llmAdapter.ensureInstalled(llmContext);
        await llmAdapter.logDiagnostics(llmContext, request);
        prepared = true;
      }

      const result = await Promise.race([
        llmAdapter.run(llmContext, request),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs))
      ]);
      const elapsedMs = Date.now() - startedAt;

      if ('timedOut' in result) {
        return {
          status: 'timed_out',
          elapsedMs,
          timeoutMs
        };
      }

      if (!result.success) {
        return {
          status: 'failed',
          elapsedMs,
          message: result.stderr || 'Prompt-recipe execution failed.',
          rawOutput: result.stdout
        };
      }

      return {
        status: 'success',
        elapsedMs,
        rawOutput: result.stdout ?? ''
      };
    }
  };
}

function formatPreviewDiscoveryLog(discovery: PreviewAdapterResult) {
  const checks = discovery.compatibility.checks.length
    ? discovery.compatibility.checks
        .map((check) => {
          const parts = [
            check.name ?? '(unnamed check)',
            check.appSlug ? `app=${check.appSlug}` : undefined,
            check.rawSource ? `source=${check.rawSource}` : undefined,
            check.status ? `status=${check.status}` : undefined,
            check.conclusion ? `conclusion=${check.conclusion}` : undefined,
            `score=${check.score}`,
            check.matchedAdapter ? `adapter=${check.matchedAdapter}` : undefined,
            check.extracted ? 'preview=found' : 'preview=missing'
          ].filter(Boolean);
          return parts.join(' ');
        })
        .join(' | ')
    : 'no check runs returned';

  const diagnostics = discovery.resolution.diagnostics.length
    ? ` | diagnostics: ${discovery.resolution.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`
    : '';

  if (discovery.resolution.previewUrl) {
    return `Preview discovery matched ${discovery.compatibility.matchedCheck ?? 'unknown check'} via ${discovery.compatibility.adapter ?? discovery.resolution.adapter} from ${discovery.compatibility.source ?? 'unknown source'}: ${discovery.resolution.previewUrl} | checks: ${checks}${diagnostics}`;
  }

  return `${discovery.resolution.explanation} | checks: ${checks}${diagnostics}`;
}

async function getScmCredential(
  env: Stage3Env,
  repo: Repo,
  scmAdapter: ScmAdapter
): Promise<ScmAdapterCredential> {
  if (scmAdapter.provider === 'github' && env.GITHUB_TOKEN?.trim()) {
    return { token: env.GITHUB_TOKEN.trim() };
  }
  if (scmAdapter.provider === 'gitlab' && env.GITLAB_TOKEN?.trim()) {
    return { token: env.GITLAB_TOKEN.trim() };
  }
  throw new NonRetryableError(
    `Missing ${scmAdapter.provider === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'} secret for provider ${scmAdapter.provider} host ${getRepoHost(repo)}.`
  );
}

async function configureSandboxRuntimeSecrets(
  sandbox: ReturnType<typeof getSandbox>,
  env: Stage3Env
) {
  const exports: string[] = [];
  if (env.OPENAI_API_KEY?.trim()) {
    exports.push(`export OPENAI_API_KEY=${shellQuote(env.OPENAI_API_KEY.trim())}`);
  }
  await sandbox.writeFile(
    '/workspace/agent-env.sh',
    exports.length ? `${exports.join('\n')}\n` : '# no runtime env exports configured\n'
  );
}

async function persistArtifactManifest(env: Stage3Env, run: Awaited<ReturnType<RepoBoardDO['getRun']>>) {
  const manifest = run.artifactManifest;
  if (!manifest || !env.RUN_ARTIFACTS) {
    return;
  }
  const payload = JSON.stringify(manifest, null, 2);
  await env.RUN_ARTIFACTS.put(`runs/${run.runId}/manifest.json`, payload, {
    httpMetadata: { contentType: 'application/json' }
  });
  await writeUsageLedgerEntriesBestEffort(env, [
    {
      tenantId: normalizeTenantId(run.tenantId),
      repoId: run.repoId,
      taskId: run.taskId,
      runId: run.runId,
      category: 'r2_write_ops',
      quantity: 1,
      source: 'workflow',
      metadata: { object: 'manifest.json' }
    },
    {
      tenantId: normalizeTenantId(run.tenantId),
      repoId: run.repoId,
      taskId: run.taskId,
      runId: run.runId,
      category: 'r2_storage_bytes',
      quantity: payload.length,
      source: 'workflow',
      metadata: { object: 'manifest.json' }
    }
  ]);
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
    tenantId: run.tenantId,
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

function buildLlmPrompt(task: Task, repo: Repo, run: Awaited<ReturnType<RepoBoardDO['getRun']>>) {
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
      ? `- The outer system already prepared the existing review branch ${run.branchName} for this change request. Update that branch in place and keep the existing review request alive.`
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
  if (run.changeRequest?.prompt && getRunReviewUrl(run)) {
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, `Preparing existing review branch ${run.branchName} for a review change request.`, 'bootstrap')
    ]);
    const checkout = await sandbox.exec(
      `cd /workspace/repo && git fetch origin ${shellEscape(run.branchName)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`
    );
    await appendCommandLogs(repoBoard, runId, 'bootstrap', checkout.stdout, checkout.stderr);
    if (!checkout.success) {
      throw new Error(checkout.stderr || `Failed to prepare existing review branch ${run.branchName}.`);
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
    `cd /workspace/repo && git fetch origin ${shellEscape(getScmSourceRefFetchSpec(normalized))} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`
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
    tenantId: run.tenantId,
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
