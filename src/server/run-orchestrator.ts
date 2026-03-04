import { getSandbox, type ExecResult } from '@cloudflare/sandbox';
import type { RepoBoardDO } from './durable/repo-board';
import type { BoardIndexDO } from './durable/board-index';
import type { AutoReviewProvider, LlmReasoningEffort, Repo, RunCommand, RunCommandPhase, RunEvent, Task } from '../ui/domain/types';
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
import { redactSensitiveText } from './security/redaction';
import {
  attachReviewArtifactsToManifest,
  buildReviewArtifactPointers,
  buildReviewFindingsJsonArtifact,
  buildReviewFindingsMarkdownArtifact,
  buildRunReviewArtifacts,
  parseReviewFindings,
  resolveAutoReviewConfig,
  REVIEW_FINDINGS_OUTPUT_SCHEMA
} from './shared/review-contract';
import { executePromptWithLlmAdapter } from './llm/runtime';
import { getReviewPostingAdapter } from './review-posting/registry';
import { normalizeRepoCheckpointConfig } from '../shared/checkpoint';

type WorkflowBinding<T> = {
  create(options?: { id?: string; params?: T; retention?: { successRetention?: string | number; errorRetention?: string | number } }): Promise<{ id: string }>;
};

type Stage3Env = Env & {
  RUN_WORKFLOW?: WorkflowBinding<RunJobParams>;
  RUN_ARTIFACTS?: R2Bucket;
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  JIRA_TOKEN?: string;
  OPENAI_API_KEY?: string;
};

type SleepFn = (name: string, duration: number | `${number} ${string}`) => Promise<void>;
type RunPhase = NonNullable<ReturnType<typeof buildRunLog>['phase']>;
type SandboxRole = 'main' | 'preview' | 'evidence' | 'review';
type PushRemediationResult = {
  branchName?: string;
  diagnostics: string;
};

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
  if ((run.status === 'FAILED' || run.status === 'DONE') && params.mode !== 'review_only') {
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
  let sandboxId: string | undefined;
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

    if (params.mode === 'review_only') {
      await executeRunReview(env as Stage3Env, repoBoard, detail.task, repo, params.runId, 'manual_rerun', sleepFn);
      return;
    }

    const scmCredential = await getScmCredential(env as Stage3Env, repo, scmAdapter);
    sandboxId = buildSandboxId(params.runId, 'main');
    const sandbox = getSandbox(env.Sandbox, sandboxId);
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
      sandboxId,
      llmAdapter: llmAdapter.kind,
      llmSupportsResume: llmAdapter.capabilities.supportsResume,
      appendTimelineNote: 'Sandbox bootstrapped.'
    });

    try {
      await emitCommandLifecycle(repoBoard, params.runId, 'bootstrap', 'mkdir -p /workspace/repo', () => sandbox.exec('mkdir -p /workspace/repo'));
      await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `Using configured ${scmAdapter.provider} credentials.`, 'bootstrap')]);
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

    await checkpointPhaseBoundaryOrFail({
      repoBoard,
      runId: params.runId,
      repo,
      task: detail.task,
      sandbox,
      phase: 'bootstrap'
    });

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

    await checkpointPhaseBoundaryOrFail({
      repoBoard,
      runId: params.runId,
      repo,
      task: detail.task,
      sandbox,
      phase: 'codex'
    });

    await repoBoard.transitionRun(params.runId, {
      status: 'RUNNING_TESTS',
      appendTimelineNote: `${llmExecutorLabel}-selected validation commands executed inside the sandbox.`,
      executionSummary: { testsOutcome: 'skipped' }
    });
    await repoBoard.appendRunLogs(params.runId, [buildRunLog(params.runId, `${llmExecutorLabel} was responsible for choosing and running validation commands.`, 'tests')]);

    await checkpointPhaseBoundaryOrFail({
      repoBoard,
      runId: params.runId,
      repo,
      task: detail.task,
      sandbox,
      phase: 'tests'
    });

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

      const reviewPrepResult = await prepareReviewBranchForFirstReview({
        repoBoard,
        runId: params.runId,
        repo,
        sandbox
      });

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
      let effectiveBranchName = run.branchName;
      const pushToBranch = async (branchName: string) =>
        emitCommandLifecycle(repoBoard, params.runId, 'push', `cd /workspace/repo && git push origin HEAD:${shellEscape(branchName)}`, () =>
          sandbox.exec(`cd /workspace/repo && git push origin HEAD:${shellEscape(branchName)}`)
        );
      const pushWithAdaptiveRecovery = async () => {
        const initialPush = await pushToBranch(run.branchName);
        if (initialPush.success) {
          return run.branchName;
        }

        const initialError = formatPushFailureOutput(initialPush.stderr, initialPush.stdout, 'Push failed.');
        if (!isBranchPolicyPushFailure(initialError)) {
          throw new Error(initialError);
        }

        if (run.changeRequest?.prompt && getRunReviewUrl(run)) {
          throw new Error(
            [
              `Push rejected by branch policy for existing review branch ${run.branchName}.`,
              'Branch rename remediation is disabled for change requests that must update an existing review.',
              `Remote error: ${initialError}`
            ].join(' ')
          );
        }

        await repoBoard.appendRunLogs(params.runId, [
          buildRunLog(
            params.runId,
            'Initial push was rejected by remote branch policy. Attempting one LLM-guided branch-name remediation pass.',
            'push'
          )
        ]);

        const remediation = await proposePushBranchRemediation({
          llmAdapter,
          llmContext,
          repo,
          task: detail.task,
          run,
          cwd: '/workspace/repo',
          model: llmModel,
          reasoningEffort: llmReasoningEffort,
          initialBranchName: run.branchName,
          initialError
        });
        if (!remediation.branchName) {
          throw new Error(`Push remediation failed to produce a valid branch candidate. ${remediation.diagnostics}`);
        }

        await repoBoard.appendRunLogs(params.runId, [
          buildRunLog(params.runId, `LLM remediation proposed push branch ${remediation.branchName}.`, 'push')
        ]);

        const remediationPush = await pushToBranch(remediation.branchName);
        if (!remediationPush.success) {
          const remediationError = formatPushFailureOutput(remediationPush.stderr, remediationPush.stdout, 'Push failed.');
          throw new Error(
            [
              'Push remediation attempt failed.',
              `Original push error: ${initialError}`,
              `Remediation diagnostics: ${remediation.diagnostics}`,
              `Remediation push error: ${remediationError}`
            ].join(' ')
          );
        }

        await repoBoard.appendRunLogs(params.runId, [
          buildRunLog(params.runId, `Push remediation succeeded; adopting branch ${remediation.branchName}.`, 'push')
        ]);
        return remediation.branchName;
      };

      if (hasWorkingTreeChanges) {
        commitMessage = await resolveCommitMessageForRun({
          llmAdapter,
          llmContext,
          repo,
          task: detail.task,
          run,
          model: llmModel,
          reasoningEffort: llmReasoningEffort,
          candidate: buildDefaultCommitMessage(detail.task, run, repo)
        });
        const commitResult = await emitCommandLifecycle(
          repoBoard,
          params.runId,
          'push',
          `cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)}`,
          () => sandbox.exec(`cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)}`)
        );
        if (!commitResult.success) {
          throw new Error(formatPushFailureOutput(commitResult.stderr, commitResult.stdout, 'Commit failed.'));
        }
        effectiveBranchName = await pushWithAdaptiveRecovery();
      } else {
        const commitMessageResult = await emitCommandLifecycle(repoBoard, params.runId, 'push', 'cd /workspace/repo && git log -1 --pretty=%s', () =>
          sandbox.exec('cd /workspace/repo && git log -1 --pretty=%s')
        );
        if (!commitMessageResult.success) {
          throw new Error(commitMessageResult.stderr || 'Failed to read the existing commit message.');
        }
        const existingCommitMessage = commitMessageResult.stdout.trim() || buildDefaultCommitMessage(detail.task, run, repo);
        commitMessage = await resolveCommitMessageForRun({
          llmAdapter,
          llmContext,
          repo,
          task: detail.task,
          run,
          model: llmModel,
          reasoningEffort: llmReasoningEffort,
          candidate: existingCommitMessage
        });
        if (commitMessage !== existingCommitMessage) {
          const amendResult = await emitCommandLifecycle(
            repoBoard,
            params.runId,
            'push',
            `cd /workspace/repo && git commit --amend -m ${shellQuote(commitMessage)}`,
            () => sandbox.exec(`cd /workspace/repo && git commit --amend -m ${shellQuote(commitMessage)}`)
          );
          if (!amendResult.success) {
            throw new Error(formatPushFailureOutput(amendResult.stderr, amendResult.stdout, 'Failed to amend commit message.'));
          }
          await repoBoard.appendRunLogs(params.runId, [
            buildRunLog(params.runId, 'Amended existing local commit message to satisfy repo commit policy.', 'push')
          ]);
        }
        await repoBoard.appendRunLogs(params.runId, [
          buildRunLog(params.runId, `Detected an existing local commit from ${llmExecutorLabel}; pushing it without creating another commit.`, 'push')
        ]);
        effectiveBranchName = await pushWithAdaptiveRecovery();
      }

      if (reviewPrepResult.mustVerifyContextFileAbsent) {
        await verifyContextFileAbsentFromHeadOrFail({
          repoBoard,
          runId: params.runId,
          sandbox,
          contextNotesPath: reviewPrepResult.contextNotesPath
        });
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
        branchName: effectiveBranchName,
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

    await executeRunReview(env as Stage3Env, repoBoard, detail.task, repo, params.runId, 'auto_on_review', sleepFn);

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
    if (sandboxStartedAtMs !== undefined && sandboxId) {
      await emitUsage([
        {
          category: 'sandbox_runtime_ms',
          quantity: Math.max(0, endedAtMs - sandboxStartedAtMs),
          source: 'sandbox',
          metadata: { sandboxId }
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

  const evidenceSandboxId = buildSandboxId(runId, 'evidence');
  const sandbox = getSandbox(env.Sandbox, evidenceSandboxId);
  await repoBoard.transitionRun(runId, { status: 'EVIDENCE_RUNNING', evidenceStatus: 'RUNNING', evidenceSandboxId });
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

async function executeRunReview(
  env: Stage3Env,
  repoBoard: DurableObjectStub<RepoBoardDO>,
  task: Task,
  repo: Repo,
  runId: string,
  trigger: 'auto_on_review' | 'manual_rerun',
  sleepFn: SleepFn
) {
  const baseRun = await repoBoard.getRun(runId);
  if (baseRun.reviewExecution?.status === 'running') {
    return;
  }

  const autoReview = resolveAutoReviewConfig(repo, task);
  const previousRound = baseRun.reviewExecution?.round ?? 0;
  if (!autoReview.enabled) {
    await repoBoard.transitionRun(runId, {
      reviewExecution: {
        enabled: false,
        trigger,
        promptSource: autoReview.promptSource,
        status: 'not_started',
        round: previousRound
      },
      appendTimelineNote: trigger === 'auto_on_review'
        ? 'Auto-review skipped: disabled for this run context.'
        : 'Manual review rerun skipped: auto-review is disabled for this run context.'
    });
    return;
  }

  const startedAt = new Date().toISOString();
  const round = previousRound + 1;
  await repoBoard.transitionRun(runId, {
    reviewExecution: {
      enabled: true,
      trigger,
      promptSource: autoReview.promptSource,
      status: 'running',
      round,
      startedAt
    },
    reviewPostState: {
      provider: autoReview.provider,
      round,
      status: 'not_attempted',
      startedAt,
      postedCount: 0,
      findingsCount: 0,
      errors: []
    },
    appendTimelineNote: `${trigger === 'auto_on_review' ? 'Auto' : 'Manual'} review started (round ${round}).`
  });
  await repoBoard.appendRunLogs(runId, [
    buildRunLog(runId, `Running ${trigger === 'auto_on_review' ? 'automatic' : 'manual'} review round ${round}.`, 'pr')
  ]);

  try {
    const run = await repoBoard.getRun(runId);
    const llmAdapterKind = resolveLlmAdapterKind(task, run.llmAdapter);
    const llmAdapter = getLlmAdapter(llmAdapterKind);
    const llmModel = task.uiMeta?.llmModel ?? task.uiMeta?.codexModel ?? 'gpt-5.1-codex-mini';
    const llmReasoningEffort = task.uiMeta?.llmReasoningEffort ?? task.uiMeta?.codexReasoningEffort ?? 'medium';
    const scmAdapter = getScmAdapter(repo);
    const scmCredential = await getScmCredential(env, repo, scmAdapter);
    const reviewSandboxId = buildSandboxId(runId, 'review');
    const reviewSandbox = getSandbox(env.Sandbox, reviewSandboxId);
    const llmContext = { env, sandbox: reviewSandbox, repoBoard, runId };
    await repoBoard.transitionRun(runId, { reviewSandboxId });

    await configureSandboxRuntimeSecrets(reviewSandbox, env);
    const cloneUrl = scmAdapter.buildCloneUrl(repo, scmCredential);
    const repoState = await emitCommandLifecycle(
      repoBoard,
      runId,
      'pr',
      `bash -lc ${shellQuote(`if [ -d /workspace/repo/.git ]; then
  echo existing_git
elif [ -d /workspace/repo ]; then
  echo existing_non_git
else
  echo missing
fi`)}`,
      () => reviewSandbox.exec(
        `bash -lc ${shellQuote(`if [ -d /workspace/repo/.git ]; then
  echo existing_git
elif [ -d /workspace/repo ]; then
  echo existing_non_git
else
  echo missing
fi`)}`
      )
    );
    if (!repoState.success) {
      throw new Error(repoState.stderr || 'Failed to inspect review workspace before checkout.');
    }
    const workspaceState = (repoState.stdout ?? '').trim();

    if (workspaceState === 'existing_git') {
      const resetWorkspace = await emitCommandLifecycle(
        repoBoard,
        runId,
        'pr',
        'cd /workspace/repo && git reset --hard && git clean -fdx',
        () => reviewSandbox.exec('cd /workspace/repo && git reset --hard && git clean -fdx')
      );
      if (!resetWorkspace.success) {
        throw new Error(resetWorkspace.stderr || 'Failed to reset existing review workspace.');
      }
    } else {
      if (workspaceState === 'existing_non_git') {
        const cleanupWorkspace = await emitCommandLifecycle(
          repoBoard,
          runId,
          'pr',
          'rm -rf /workspace/repo',
          () => reviewSandbox.exec('rm -rf /workspace/repo')
        );
        if (!cleanupWorkspace.success) {
          throw new Error(cleanupWorkspace.stderr || 'Failed to clean stale review workspace.');
        }
      }

      await checkoutReviewWorkspace({
        repoBoard,
        reviewSandbox,
        runId,
        cloneUrl,
        defaultBranch: repo.defaultBranch
      });
    }
    const checkout = await emitCommandLifecycle(
      repoBoard,
      runId,
      'pr',
      `cd /workspace/repo && git fetch origin ${shellEscape(run.branchName)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`,
      () => reviewSandbox.exec(`cd /workspace/repo && git fetch origin ${shellEscape(run.branchName)} && git checkout -B ${shellEscape(run.branchName)} FETCH_HEAD`)
    );
    if (!checkout.success) {
      throw new Error(checkout.stderr || `Failed to prepare review branch ${run.branchName}.`);
    }

    const parsed = autoReview.promptSource === 'native'
      ? await runNativeReviewAndNormalize({
        llmAdapter,
        llmContext,
        repo,
        task,
        run,
        model: llmModel,
        reasoningEffort: llmReasoningEffort,
        sleepFn,
        autoReview
      })
      : await runStructuredReview({
        llmAdapter,
        llmContext,
        repo,
        task,
        run,
        model: llmModel,
        reasoningEffort: llmReasoningEffort,
        sleepFn,
        autoReview
      });
    if (!parsed.ok) {
      throw new Error(`${parsed.code}: ${parsed.message}`);
    }

    const postingStartedAt = new Date().toISOString();
    let postErrors: string[] = [];
    let postedCount = 0;
    let findings = parsed.findings;
    let agentReportedPostedCount = 0;
    let platformFallbackTriggered = false;
    let summaryPosted: boolean | undefined;
    let summaryThreadId: string | undefined;
    let summaryThreadUrl: string | undefined;
    if (autoReview.postingMode === 'agent') {
      agentReportedPostedCount = findings.filter((finding) => Boolean(finding.providerThreadId?.trim())).length;
      postedCount = agentReportedPostedCount;

      if (findings.length > 0 && postedCount === 0) {
        const reviewCredential = getReviewPostingCredential(env, autoReview.provider);
        if (!reviewCredential) {
          postErrors = [buildMissingReviewPostingCredentialError(autoReview.provider)];
        } else {
          platformFallbackTriggered = true;
          try {
            const postingAdapter = getReviewPostingAdapter(autoReview.provider);
            const posting = await postingAdapter.postFindings({
              repo,
              task,
              run,
              findings,
              credential: reviewCredential,
              postInline: autoReview.postInline
            });
            findings = posting.updatedFindings;
            postedCount = posting.findings.filter((entry) => entry.posted).length;
            postErrors = posting.errors;
            summaryPosted = posting.summary?.posted;
            summaryThreadId = posting.summary?.providerThreadId;
            summaryThreadUrl = posting.summary?.providerThreadUrl;
          } catch (error) {
            postErrors = [error instanceof Error ? error.message : String(error)];
          }
        }
      }
    } else {
      const reviewCredential = getReviewPostingCredential(env, autoReview.provider);

      if (!reviewCredential) {
        postErrors = [buildMissingReviewPostingCredentialError(autoReview.provider)];
      } else {
        try {
          const postingAdapter = getReviewPostingAdapter(autoReview.provider);
          const posting = await postingAdapter.postFindings({
            repo,
            task,
            run,
            findings,
            credential: reviewCredential,
            postInline: autoReview.postInline
          });
          findings = posting.updatedFindings;
          postedCount = posting.findings.filter((entry) => entry.posted).length;
          postErrors = posting.errors;
          summaryPosted = posting.summary?.posted;
          summaryThreadId = posting.summary?.providerThreadId;
          summaryThreadUrl = posting.summary?.providerThreadUrl;
        } catch (error) {
          postErrors = [error instanceof Error ? error.message : String(error)];
        }
      }
    }
    const sanitizedPostErrors = postErrors.map((error) => redactSensitiveText(error));
    const reviewPostStatus = sanitizedPostErrors.length ? 'failed' : 'completed';
    const postingOutcomeNote = sanitizedPostErrors.length
      ? `Review completed (round ${round}; ${findings.length} findings, ${postedCount} posted). Posting via ${autoReview.provider}/${autoReview.postingMode} failed: ${sanitizedPostErrors[0]}`
      : `Review completed (round ${round}; ${findings.length} findings, ${postedCount} posted). Posting via ${autoReview.provider}/${autoReview.postingMode} succeeded.`;

    await repoBoard.appendRunLogs(runId, [
      buildRunLog(
        runId,
        sanitizedPostErrors.length
          ? `Review posting via ${autoReview.provider}/${autoReview.postingMode} failed with ${sanitizedPostErrors.length} error(s): ${sanitizedPostErrors[0]}`
          : `Review posting via ${autoReview.provider}/${autoReview.postingMode} completed (${postedCount}/${findings.length} findings posted).`,
        'pr',
        sanitizedPostErrors.length ? 'error' : 'info',
        {
          reviewProvider: autoReview.provider,
          reviewPostingMode: autoReview.postingMode,
          reviewPostingStatus: reviewPostStatus,
          postedCount,
          agentReportedPostedCount,
          platformFallbackTriggered,
          findingsCount: findings.length,
          errorCount: sanitizedPostErrors.length,
          summaryPosted: Boolean(summaryPosted)
        }
      )
    ]);

    const pointers = buildReviewArtifactPointers({ tenantId: run.tenantId, runId });
    const findingsJson = buildReviewFindingsJsonArtifact(findings);
    const findingsMarkdown = buildReviewFindingsMarkdownArtifact(findings);
    await persistReviewArtifacts(env, run, pointers.findingsJson.key, findingsJson, pointers.reviewMarkdown.key, findingsMarkdown);
    const reviewArtifacts = buildRunReviewArtifacts({ tenantId: run.tenantId, runId });
    const latestRun = await repoBoard.getRun(runId);
    const endedAt = new Date().toISOString();

    await repoBoard.transitionRun(runId, {
      reviewExecution: {
        enabled: true,
        trigger,
        promptSource: autoReview.promptSource,
        status: 'completed',
        round,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      },
      reviewFindings: findings,
      reviewFindingsSummary: {
        total: findings.length,
        open: findings.filter((finding) => finding.status === 'open').length,
        posted: postedCount,
        provider: autoReview.provider
      },
      reviewArtifacts,
      reviewPostState: {
        provider: autoReview.provider,
        round,
        status: reviewPostStatus,
        startedAt: postingStartedAt,
        endedAt,
        postedCount,
        findingsCount: findings.length,
        errors: sanitizedPostErrors,
        summaryPosted,
        summaryThreadId,
        summaryThreadUrl
      },
      artifactManifest: latestRun.artifactManifest
        ? attachReviewArtifactsToManifest(latestRun.artifactManifest, { tenantId: run.tenantId, runId })
        : undefined,
      artifacts: [...new Set([...(latestRun.artifacts ?? []), reviewArtifacts.findingsJsonKey, reviewArtifacts.reviewMarkdownKey])],
      appendTimelineNote: postingOutcomeNote
    });
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, `Review round ${round} completed with ${findings.length} findings (${postedCount} posted).`, 'pr')]);
  } catch (error) {
    const endedAt = new Date().toISOString();
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    const latestRun = await repoBoard.getRun(runId);
    await repoBoard.appendRunLogs(runId, [buildRunLog(runId, message, 'pr', 'error')]);
    await repoBoard.transitionRun(runId, {
      reviewExecution: {
        enabled: true,
        trigger,
        promptSource: autoReview.promptSource,
        status: 'failed',
        round,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      },
      reviewPostState: latestRun.reviewPostState?.round === round
        ? {
            ...latestRun.reviewPostState,
            status: 'failed',
            endedAt,
            errors: latestRun.reviewPostState.errors.length ? latestRun.reviewPostState.errors : [message]
          }
        : {
            provider: autoReview.provider,
            round,
            status: 'failed',
            startedAt,
            endedAt,
            postedCount: 0,
            findingsCount: 0,
            errors: [message]
          },
      appendTimelineNote: `Review failed (round ${round}): ${message}`
    });
  }
}

function buildReviewPrompt(
  task: Task,
  repo: Repo,
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>,
  autoReview: { prompt?: string; provider: AutoReviewProvider; postingMode: 'platform' | 'agent'; postInline: boolean }
) {
  const customPrompt = autoReview.prompt;
  const useNativeReview = !customPrompt?.trim();
  const reviewIntent = customPrompt?.trim()
    ? `Review instructions:\n${customPrompt.trim()}`
    : [
        'Review instructions:',
        '/review',
        'Use native review mode focused on correctness, regressions, security risks, and missing tests.',
        'Only report actionable findings that should block merge.'
      ].join('\n');

  const reviewNumber = run.reviewNumber ?? run.prNumber;
  const reviewUrl = run.reviewUrl ?? run.prUrl;
  const agentPostingGuidance = autoReview.postingMode === 'agent'
    ? [
        '',
        `Posting mode: agent-managed (${autoReview.provider}).`,
        'After you identify findings, post them directly to the provider from this sandbox using available credentials in env.',
        `Provider target: ${autoReview.provider}${reviewNumber ? ` #${reviewNumber}` : ''}${reviewUrl ? ` (${reviewUrl})` : ''}.`,
        autoReview.provider === 'github'
          ? 'For GitHub, prefer inline PR review comments when file+line map to the current diff; fallback to a PR issue comment summary when inline is not possible.'
          : 'Prefer inline comments when possible; fallback to a summary thread when inline is not possible.',
        'Include the resulting provider thread/comment id in each finding as providerThreadId.',
        'If multiple findings are posted in one summary comment, reuse that same providerThreadId on each finding.',
        'Do not skip posting when findings exist.'
      ]
    : [];

  return [
    `You are reviewing code changes for ${repo.slug}.`,
    `Run: ${run.runId}`,
    `Branch: ${run.branchName}`,
    '',
    `Task: ${task.title}`,
    task.description ? `Task description: ${task.description}` : undefined,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    reviewIntent,
    ...agentPostingGuidance,
    ...(useNativeReview
      ? [
          '',
          'If native review mode emits narrative output first, convert it into the structured findings JSON below.'
        ]
      : []),
    '',
    'Return JSON only using this exact schema shape:',
    '{ "findings": [ { "severity": "critical|high|medium|low|info", "title": "string", "description": "string", "filePath": "string|null?", "lineStart": "number|null?", "lineEnd": "number|null?", "providerThreadId": "string|null?" } ] }',
    'If there are no issues, return {"findings":[]}.'
  ].filter(Boolean).join('\n');
}

async function runStructuredReview({
  llmAdapter,
  llmContext,
  repo,
  task,
  run,
  model,
  reasoningEffort,
  sleepFn,
  autoReview
}: {
  llmAdapter: ReturnType<typeof getLlmAdapter>;
  llmContext: { env: Env; sandbox: ReturnType<typeof getSandbox>; repoBoard: DurableObjectStub<RepoBoardDO>; runId: string };
  repo: Repo;
  task: Task;
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>;
  model: string;
  reasoningEffort: LlmReasoningEffort;
  sleepFn: SleepFn;
  autoReview: { prompt?: string; provider: AutoReviewProvider; postingMode: 'platform' | 'agent'; postInline: boolean };
}) {
  const promptResult = await executePromptWithLlmAdapter(
    llmAdapter,
    llmContext,
    {
      repo,
      task,
      run,
      cwd: '/workspace/repo',
      prompt: buildReviewPrompt(task, repo, run, autoReview),
      model,
      reasoningEffort,
      timeoutMs: 180_000,
      outputSchema: REVIEW_FINDINGS_OUTPUT_SCHEMA,
      phase: 'pr'
    },
    sleepFn
  );
  if (promptResult.status !== 'success') {
    throw new Error(
      promptResult.status === 'timed_out'
        ? `Review prompt timed out after ${promptResult.timeoutMs}ms.`
        : promptResult.message
    );
  }
  return parseReviewFindings(promptResult.rawOutput);
}

async function runNativeReviewAndNormalize({
  llmAdapter,
  llmContext,
  repo,
  task,
  run,
  model,
  reasoningEffort,
  sleepFn,
  autoReview
}: {
  llmAdapter: ReturnType<typeof getLlmAdapter>;
  llmContext: { env: Env; sandbox: ReturnType<typeof getSandbox>; repoBoard: DurableObjectStub<RepoBoardDO>; runId: string };
  repo: Repo;
  task: Task;
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>;
  model: string;
  reasoningEffort: LlmReasoningEffort;
  sleepFn: SleepFn;
  autoReview: { prompt?: string; provider: AutoReviewProvider; postingMode: 'platform' | 'agent'; postInline: boolean };
}) {
  const nativeReviewResult = await executePromptWithLlmAdapter(
    llmAdapter,
    llmContext,
    {
      repo,
      task,
      run,
      cwd: '/workspace/repo',
      prompt: buildNativeReviewPrompt(task, repo, run),
      model,
      reasoningEffort,
      timeoutMs: 180_000,
      phase: 'pr'
    },
    sleepFn
  );

  if (nativeReviewResult.status !== 'success') {
    throw new Error(
      nativeReviewResult.status === 'timed_out'
        ? `Native review command timed out after ${nativeReviewResult.timeoutMs}ms.`
        : nativeReviewResult.message
    );
  }

  const normalizeResult = await executePromptWithLlmAdapter(
    llmAdapter,
    llmContext,
    {
      repo,
      task,
      run,
      cwd: '/workspace/repo',
      prompt: buildReviewNormalizationPrompt(nativeReviewResult.rawOutput, autoReview),
      model,
      reasoningEffort,
      timeoutMs: 60_000,
      outputSchema: REVIEW_FINDINGS_OUTPUT_SCHEMA,
      phase: 'pr'
    },
    sleepFn
  );

  if (normalizeResult.status !== 'success') {
    throw new Error(
      normalizeResult.status === 'timed_out'
        ? `Review findings normalization timed out after ${normalizeResult.timeoutMs}ms.`
        : normalizeResult.message
    );
  }
  return parseReviewFindings(normalizeResult.rawOutput);
}

function buildNativeReviewPrompt(task: Task, repo: Repo, run: Awaited<ReturnType<RepoBoardDO['getRun']>>) {
  return [
    `You are reviewing code changes for ${repo.slug}.`,
    `Run: ${run.runId}`,
    `Branch: ${run.branchName}`,
    '',
    `Task: ${task.title}`,
    task.description ? `Task description: ${task.description}` : undefined,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    'Run /review on the current branch diff and return a concise narrative review.',
    'Focus on correctness, regressions, security risks, and missing tests.'
  ].filter(Boolean).join('\n');
}

function buildReviewNormalizationPrompt(
  rawReviewOutput: string,
  autoReview: { provider: AutoReviewProvider; postingMode: 'platform' | 'agent' }
) {
  const trimmed = rawReviewOutput.trim();
  const summary = trimmed.length > 20_000 ? `${trimmed.slice(0, 20_000)}\n\n[truncated]` : trimmed;
  return [
    'Convert the following review output into strict findings JSON.',
    'Return JSON only using this exact schema shape:',
    '{ "findings": [ { "severity": "critical|high|medium|low|info", "title": "string", "description": "string", "filePath": "string|null?", "lineStart": "number|null?", "lineEnd": "number|null?", "providerThreadId": "string|null?" } ] }',
    'If there are no actionable issues, return {"findings":[]}.',
    autoReview.postingMode === 'agent'
      ? `If the review output includes posted ${autoReview.provider} thread/comment IDs, include them in providerThreadId.`
      : 'Set providerThreadId to null unless an explicit thread/comment id is present in the review output.',
    '',
    'Review output:',
    summary || '(empty)'
  ].join('\n');
}

async function checkoutReviewWorkspace({
  repoBoard,
  reviewSandbox,
  runId,
  cloneUrl,
  defaultBranch
}: {
  repoBoard: DurableObjectStub<RepoBoardDO>;
  reviewSandbox: ReturnType<typeof getSandbox>;
  runId: string;
  cloneUrl: string;
  defaultBranch: string;
}) {
  try {
    await reviewSandbox.gitCheckout(cloneUrl, {
      branch: defaultBranch,
      targetDir: '/workspace/repo'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const likelyExistingDir = /already exists|not an empty directory/i.test(message);
    if (!likelyExistingDir) {
      throw error;
    }

    const cleanupWorkspace = await emitCommandLifecycle(
      repoBoard,
      runId,
      'pr',
      'rm -rf /workspace/repo',
      () => reviewSandbox.exec('rm -rf /workspace/repo')
    );
    if (!cleanupWorkspace.success) {
      throw new Error(cleanupWorkspace.stderr || 'Failed to clean review workspace after checkout collision.');
    }

    await reviewSandbox.gitCheckout(cloneUrl, {
      branch: defaultBranch,
      targetDir: '/workspace/repo'
    });
  }
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
  const previewSandboxId = buildSandboxId(runId, 'preview');
  const sandbox = getSandbox(env.Sandbox, previewSandboxId);
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

async function checkpointPhaseBoundaryOrFail(input: {
  repoBoard: DurableObjectStub<RepoBoardDO>;
  runId: string;
  repo: Repo;
  task: Task;
  sandbox: ReturnType<typeof getSandbox>;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push';
}) {
  try {
    await createPhaseBoundaryCheckpoint(input);
  } catch (error) {
    await failRun(input.repoBoard, input.runId, 'CHECKPOINT_FAILED', input.phase, error);
    throw error;
  }
}

async function createPhaseBoundaryCheckpoint(input: {
  repoBoard: DurableObjectStub<RepoBoardDO>;
  runId: string;
  repo: Repo;
  task: Task;
  sandbox: ReturnType<typeof getSandbox>;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push';
}) {
  const normalizedRepo = normalizeRepoCheckpointConfig(input.repo);
  if (!normalizedRepo.checkpointConfig.enabled || normalizedRepo.checkpointConfig.triggerMode !== 'phase_boundary') {
    return;
  }

  const runAtStart = await input.repoBoard.getRun(input.runId);
  const existingCheckpointForPhase = findCheckpointForPhase(runAtStart.checkpoints, input.phase);
  if (existingCheckpointForPhase) {
    return;
  }

  const statusResult = await emitCommandLifecycle(
    input.repoBoard,
    input.runId,
    input.phase,
    'cd /workspace/repo && git status --short',
    () => input.sandbox.exec('cd /workspace/repo && git status --short')
  );
  if (!statusResult.success) {
    throw new Error(statusResult.stderr || `Failed to inspect git status before ${input.phase} checkpoint.`);
  }
  if (!statusResult.stdout?.trim()) {
    return;
  }

  const sequence = (runAtStart.checkpoints?.length ?? 0) + 1;
  const checkpointId = buildCheckpointId(runAtStart.runId, input.phase, sequence);
  const commitMessage = buildCheckpointCommitMessage(runAtStart.runId, input.phase, sequence);
  const contextNotesPath = normalizedRepo.checkpointConfig.contextNotes.filePath;

  if (normalizedRepo.checkpointConfig.contextNotes.enabled) {
    const contextNotesDirectory = dirname(contextNotesPath);
    if (contextNotesDirectory) {
      const mkdirResult = await emitCommandLifecycle(
        input.repoBoard,
        input.runId,
        input.phase,
        `cd /workspace/repo && mkdir -p ${shellQuote(contextNotesDirectory)}`,
        () => input.sandbox.exec(`cd /workspace/repo && mkdir -p ${shellQuote(contextNotesDirectory)}`)
      );
      if (!mkdirResult.success) {
        throw new Error(mkdirResult.stderr || `Failed to prepare context notes directory ${contextNotesDirectory}.`);
      }
    }
    await input.sandbox.writeFile(
      `/workspace/repo/${contextNotesPath}`,
      buildRunContextNote({
        task: input.task,
        repo: input.repo,
        run: runAtStart,
        phase: input.phase,
        sequence,
        contextNotesPath
      })
    );
  }

  const commitResult = await emitCommandLifecycle(input.repoBoard, input.runId, input.phase, `cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)}`, () =>
    input.sandbox.exec(`cd /workspace/repo && git add -A && git commit -m ${shellQuote(commitMessage)}`)
  );
  if (!commitResult.success) {
    if (!looksLikeNoChangesToCommit(commitResult.stderr, commitResult.stdout)) {
      throw new Error(commitResult.stderr || 'Failed to create checkpoint commit.');
    }
    const headMessage = await emitCommandLifecycle(
      input.repoBoard,
      input.runId,
      input.phase,
      'cd /workspace/repo && git log -1 --pretty=%s',
      () => input.sandbox.exec('cd /workspace/repo && git log -1 --pretty=%s')
    );
    if (!headMessage.success) {
      throw new Error(headMessage.stderr || 'Failed to read HEAD commit message while reconciling checkpoint creation.');
    }
    if (headMessage.stdout.trim() !== commitMessage) {
      return;
    }
  }

  const shaResult = await emitCommandLifecycle(
    input.repoBoard,
    input.runId,
    input.phase,
    'cd /workspace/repo && git rev-parse HEAD',
    () => input.sandbox.exec('cd /workspace/repo && git rev-parse HEAD')
  );
  if (!shaResult.success) {
    throw new Error(shaResult.stderr || 'Failed to resolve checkpoint commit SHA.');
  }
  const commitSha = shaResult.stdout.trim();
  const createdAt = new Date().toISOString();
  const checkpoint = {
    checkpointId,
    runId: runAtStart.runId,
    repoId: runAtStart.repoId,
    taskId: runAtStart.taskId,
    phase: input.phase,
    commitSha,
    commitMessage,
    contextNotesPath: normalizedRepo.checkpointConfig.contextNotes.enabled ? contextNotesPath : undefined,
    createdAt
  } as const;
  const runLatest = await input.repoBoard.getRun(input.runId);
  if (findCheckpoint(runLatest.checkpoints, checkpointId, commitSha)) {
    return;
  }
  if (findCheckpointForPhase(runLatest.checkpoints, input.phase)) {
    return;
  }
  const checkpoints = [...(runLatest.checkpoints ?? []), checkpoint];
  const updatedRun = await input.repoBoard.transitionRun(input.runId, {
    checkpoints,
    appendTimelineNote: `Checkpoint created (${input.phase}): ${commitSha.slice(0, 12)}.`
  });
  await input.repoBoard.appendRunEvents(input.runId, [
    buildRunEvent(
      updatedRun,
      'workflow',
      'run.checkpoint.created',
      `Checkpoint created at ${input.phase}: ${commitSha.slice(0, 12)}.`,
      {
        checkpointId,
        phase: input.phase,
        commitSha,
        sequence,
        hasContextNotes: normalizedRepo.checkpointConfig.contextNotes.enabled
      }
    )
  ]);
}

function looksLikeNoChangesToCommit(stderr: string | undefined, stdout: string | undefined) {
  const message = `${stderr ?? ''}\n${stdout ?? ''}`;
  return message.includes('nothing to commit') || message.includes('working tree clean');
}

function findCheckpoint(checkpoints: Awaited<ReturnType<RepoBoardDO['getRun']>>['checkpoints'], checkpointId: string, commitSha: string) {
  if (!Array.isArray(checkpoints)) {
    return undefined;
  }
  return checkpoints.find((candidate) => candidate?.checkpointId === checkpointId || candidate?.commitSha === commitSha);
}

function findCheckpointForPhase(
  checkpoints: Awaited<ReturnType<RepoBoardDO['getRun']>>['checkpoints'],
  phase: 'bootstrap' | 'codex' | 'tests' | 'push'
) {
  if (!Array.isArray(checkpoints)) {
    return undefined;
  }
  return checkpoints.find((candidate) => candidate?.phase === phase);
}

async function prepareReviewBranchForFirstReview(input: {
  repoBoard: DurableObjectStub<RepoBoardDO>;
  runId: string;
  repo: Repo;
  sandbox: ReturnType<typeof getSandbox>;
}) {
  const currentRun = await input.repoBoard.getRun(input.runId);
  const normalizedRepo = normalizeRepoCheckpointConfig(input.repo);
  const checkpointConfig = normalizedRepo.checkpointConfig;
  if (!checkpointConfig.enabled) {
    return { mustVerifyContextFileAbsent: false, contextNotesPath: '' };
  }

  const contextNotesPath = checkpointConfig.contextNotes.filePath;
  const hasExistingReview = Boolean(getRunReviewUrl(currentRun) && getRunReviewNumber(currentRun));
  const isChangeRequestRerun = Boolean(currentRun.changeRequest?.prompt && hasExistingReview);
  const allowsHistoryRewrite = !isChangeRequestRerun || checkpointConfig.reviewPrep.rewriteOnChangeRequestRerun;

  if (checkpointConfig.contextNotes.enabled && checkpointConfig.contextNotes.cleanupBeforeReview) {
    const trackedContextFile = await emitCommandLifecycle(
      input.repoBoard,
      input.runId,
      'push',
      `cd /workspace/repo && git ls-files --error-unmatch ${shellEscape(contextNotesPath)}`,
      () => input.sandbox.exec(`cd /workspace/repo && git ls-files --error-unmatch ${shellEscape(contextNotesPath)}`)
    );
    if (trackedContextFile.success) {
      const removeContextFile = await emitCommandLifecycle(
        input.repoBoard,
        input.runId,
        'push',
        `cd /workspace/repo && rm -f ${shellEscape(contextNotesPath)}`,
        () => input.sandbox.exec(`cd /workspace/repo && rm -f ${shellEscape(contextNotesPath)}`)
      );
      if (!removeContextFile.success) {
        throw new Error(removeContextFile.stderr || `Failed to remove checkpoint context notes file ${contextNotesPath} before review.`);
      }
      const runAfterCleanup = await input.repoBoard.transitionRun(input.runId, {
        appendTimelineNote: `Review prep removed checkpoint context notes (${contextNotesPath}).`
      });
      await input.repoBoard.appendRunEvents(input.runId, [
        buildRunEvent(
          runAfterCleanup,
          'workflow',
          'run.review_prep.context_cleaned',
          `Removed checkpoint context notes before review push: ${contextNotesPath}.`,
          { contextNotesPath }
        )
      ]);
    }
  }

  const shouldSquashForFirstReview = checkpointConfig.reviewPrep.squashBeforeFirstReviewOpen
    && (hasExistingReview ? allowsHistoryRewrite : true);
  const checkpointCount = currentRun.checkpoints?.length ?? 0;

  if (shouldSquashForFirstReview && checkpointCount > 0) {
    const mergeBase = await emitCommandLifecycle(
      input.repoBoard,
      input.runId,
      'push',
      `cd /workspace/repo && git merge-base HEAD origin/${shellEscape(input.repo.defaultBranch)}`,
      () => input.sandbox.exec(`cd /workspace/repo && git merge-base HEAD origin/${shellEscape(input.repo.defaultBranch)}`)
    );
    if (!mergeBase.success) {
      throw new Error(mergeBase.stderr || `Failed to resolve merge base for review prep squash against origin/${input.repo.defaultBranch}.`);
    }
    const baseSha = mergeBase.stdout.trim();
    if (!baseSha) {
      throw new Error(`Failed to resolve merge base for review prep squash against origin/${input.repo.defaultBranch}.`);
    }
    const squashResult = await emitCommandLifecycle(
      input.repoBoard,
      input.runId,
      'push',
      `cd /workspace/repo && git reset --soft ${shellEscape(baseSha)}`,
      () => input.sandbox.exec(`cd /workspace/repo && git reset --soft ${shellEscape(baseSha)}`)
    );
    if (!squashResult.success) {
      throw new Error(squashResult.stderr || 'Failed to squash checkpoint commits before first review push.');
    }
    const runAfterSquash = await input.repoBoard.transitionRun(input.runId, {
      appendTimelineNote: `Review prep squashed ${checkpointCount} checkpoint commit${checkpointCount === 1 ? '' : 's'} before first review push.`
    });
    await input.repoBoard.appendRunEvents(input.runId, [
      buildRunEvent(
        runAfterSquash,
        'workflow',
        'run.review_prep.squashed',
        `Squashed checkpoint history into a clean review-visible commit (${checkpointCount} checkpoint commit${checkpointCount === 1 ? '' : 's'}).`,
        { checkpointCount, baseSha, hasExistingReview }
      )
    ]);
  } else if (hasExistingReview && isChangeRequestRerun && checkpointConfig.reviewPrep.squashBeforeFirstReviewOpen && !allowsHistoryRewrite) {
    await input.repoBoard.transitionRun(input.runId, {
      appendTimelineNote: 'Review prep skipped checkpoint-history squash to preserve no-rewrite change-request rerun semantics.'
    });
  }

  return {
    mustVerifyContextFileAbsent: checkpointConfig.contextNotes.enabled && checkpointConfig.contextNotes.cleanupBeforeReview,
    contextNotesPath
  };
}

async function verifyContextFileAbsentFromHeadOrFail(input: {
  repoBoard: DurableObjectStub<RepoBoardDO>;
  runId: string;
  sandbox: ReturnType<typeof getSandbox>;
  contextNotesPath: string;
}) {
  const contextInHead = await emitCommandLifecycle(
    input.repoBoard,
    input.runId,
    'push',
    `cd /workspace/repo && git cat-file -e HEAD:${shellEscape(input.contextNotesPath)}`,
    () => input.sandbox.exec(`cd /workspace/repo && git cat-file -e HEAD:${shellEscape(input.contextNotesPath)}`)
  );
  if (contextInHead.success) {
    throw new Error(`Checkpoint context notes file ${input.contextNotesPath} must be absent from the review-visible HEAD commit.`);
  }
}

function buildCheckpointId(runId: string, phase: 'bootstrap' | 'codex' | 'tests' | 'push', sequence: number) {
  return `${runId}:cp:${String(sequence).padStart(3, '0')}:${phase}`;
}

function buildCheckpointCommitMessage(runId: string, phase: 'bootstrap' | 'codex' | 'tests' | 'push', sequence: number) {
  return `agentskanban checkpoint ${String(sequence).padStart(3, '0')} (${phase}) [${runId}]`;
}

function buildRunContextNote(input: {
  task: Task;
  repo: Repo;
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>;
  phase: 'bootstrap' | 'codex' | 'tests' | 'push';
  sequence: number;
  contextNotesPath: string;
}) {
  return [
    '# AgentsKanban Run Context',
    '',
    `runId: ${input.run.runId}`,
    `taskId: ${input.run.taskId}`,
    `repoId: ${input.run.repoId}`,
    `repoSlug: ${input.repo.slug}`,
    `branchName: ${input.run.branchName}`,
    `checkpointSequence: ${String(input.sequence).padStart(3, '0')}`,
    `checkpointPhase: ${input.phase}`,
    `contextNotesPath: ${input.contextNotesPath}`,
    '',
    'Task:',
    `- title: ${input.task.title}`,
    `- prompt: ${input.task.taskPrompt}`,
    '',
    'Acceptance Criteria:',
    ...input.task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    'Notes:',
    input.task.context.notes?.trim() ? `- ${input.task.context.notes.trim()}` : '- (none)',
    '',
    'Links:',
    ...(input.task.context.links.length
      ? input.task.context.links.map((link) => `- ${link.label}: ${link.url}`)
      : ['- (none)']),
    ''
  ].join('\n');
}

function dirname(path: string) {
  const normalized = path.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex <= 0) {
    return '';
  }
  return normalized.slice(0, separatorIndex);
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

function getReviewPostingCredential(env: Stage3Env, provider: AutoReviewProvider) {
  if (provider === 'github') {
    return env.GITHUB_TOKEN?.trim() ? { token: env.GITHUB_TOKEN.trim() } : undefined;
  }
  if (provider === 'gitlab') {
    return env.GITLAB_TOKEN?.trim() ? { token: env.GITLAB_TOKEN.trim() } : undefined;
  }
  return env.JIRA_TOKEN?.trim() ? { token: env.JIRA_TOKEN.trim() } : undefined;
}

function buildMissingReviewPostingCredentialError(provider: AutoReviewProvider) {
  const tokenNameByProvider: Record<AutoReviewProvider, string> = {
    github: 'GITHUB_TOKEN',
    gitlab: 'GITLAB_TOKEN',
    jira: 'JIRA_TOKEN'
  };
  const tokenName = tokenNameByProvider[provider];
  return `Missing ${tokenName}: set this secret to enable ${provider} auto-review posting.`;
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

async function persistReviewArtifacts(
  env: Stage3Env,
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>,
  findingsJsonKey: string,
  findingsJson: string,
  reviewMarkdownKey: string,
  reviewMarkdown: string
) {
  if (!env.RUN_ARTIFACTS) {
    return;
  }
  await env.RUN_ARTIFACTS.put(findingsJsonKey, findingsJson, {
    httpMetadata: { contentType: 'application/json' }
  });
  await env.RUN_ARTIFACTS.put(reviewMarkdownKey, reviewMarkdown, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' }
  });
  await writeUsageLedgerEntriesBestEffort(env, [
    {
      tenantId: normalizeTenantId(run.tenantId),
      repoId: run.repoId,
      taskId: run.taskId,
      runId: run.runId,
      category: 'r2_write_ops',
      quantity: 2,
      source: 'workflow',
      metadata: { object: 'review-artifacts' }
    },
    {
      tenantId: normalizeTenantId(run.tenantId),
      repoId: run.repoId,
      taskId: run.taskId,
      runId: run.runId,
      category: 'r2_storage_bytes',
      quantity: findingsJson.length + reviewMarkdown.length,
      source: 'workflow',
      metadata: { object: 'review-artifacts' }
    }
  ]);
}

async function failRun(repoBoard: DurableObjectStub<RepoBoardDO>, runId: string, code: string, phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>, error: unknown, retryable = true) {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  await repoBoard.appendRunLogs(runId, [buildRunLog(runId, message, phase, 'error')]);
  await repoBoard.markRunFailed(runId, {
    at: new Date().toISOString(),
    code,
    message,
    retryable,
    phase
  });
}

function buildDefaultCommitMessage(task: Task, run: Awaited<ReturnType<RepoBoardDO['getRun']>>, repo: Repo) {
  const template = repo.commitConfig?.messageTemplate;
  if (!template?.trim()) {
    return `AgentsKanban: ${task.title}`;
  }
  if (!/\{[a-zA-Z0-9_]+\}/.test(template)) {
    // Free-form policy guidance belongs in the LLM prompt, not as a literal commit subject.
    return `AgentsKanban: ${task.title}`;
  }

  const values: Record<string, string> = {
    taskTitle: task.title,
    taskId: task.taskId,
    runId: run.runId,
    repoSlug: repo.slug,
    defaultMessage: `AgentsKanban: ${task.title}`
  };
  const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => values[key] ?? '');
  return sanitizeCommitMessage(rendered) ?? `AgentsKanban: ${task.title}`;
}

function sanitizeCommitMessage(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

function getCommitPolicyRegex(repo: Repo) {
  const pattern = repo.commitConfig?.messageRegex?.trim();
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(`Invalid repo commit regex: ${pattern}`);
  }
}

async function resolveCommitMessageForRun(input: {
  llmAdapter: ReturnType<typeof getLlmAdapter>;
  llmContext: { env: Env; sandbox: ReturnType<typeof getSandbox>; repoBoard: DurableObjectStub<RepoBoardDO>; runId: string };
  repo: Repo;
  task: Task;
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>;
  model: string;
  reasoningEffort: LlmReasoningEffort;
  candidate: string;
}): Promise<string> {
  const hasPolicyGuidance = Boolean(
    input.repo.commitConfig?.messageTemplate?.trim()
    || input.repo.commitConfig?.messageRegex?.trim()
    || input.repo.commitConfig?.messageExamples?.length
  );
  const commitRegex = getCommitPolicyRegex(input.repo);
  const initial = sanitizeCommitMessage(input.candidate);
  if (!initial) {
    throw new Error('Resolved commit message is empty after normalization.');
  }
  if (!hasPolicyGuidance) {
    return initial;
  }
  if (commitRegex && commitRegex.test(initial)) {
    return initial;
  }

  const remediationPrompt = [
    'Generate a single git commit subject line that follows this repository commit convention.',
    '',
    `Repository: ${input.repo.slug}`,
    `Task: ${input.task.title}`,
    `Current commit message: ${initial}`,
    input.repo.commitConfig?.messageTemplate
      ? `Commit policy guidance: ${input.repo.commitConfig.messageTemplate}`
      : undefined,
    input.repo.commitConfig?.messageRegex ? `Required regex: ${input.repo.commitConfig?.messageRegex}` : undefined,
    input.repo.commitConfig?.messageExamples?.length
      ? ['Examples:', ...input.repo.commitConfig.messageExamples.map((example) => `- ${example}`)].join('\n')
      : undefined,
    '',
    'Return JSON only:',
    '{ "commitMessage": "string", "reason": "string (optional)" }'
  ].filter(Boolean).join('\n');
  const remediation = await input.llmAdapter.runPrompt(input.llmContext, {
    repo: input.repo,
    task: input.task,
    run: input.run,
    cwd: '/workspace/repo',
    prompt: remediationPrompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    timeoutMs: 90_000,
    phase: 'push'
  });

  if (remediation.status !== 'success') {
    if (!commitRegex) {
      return initial;
    }
    throw new Error(
      remediation.status === 'timed_out'
        ? `Commit message remediation timed out after ${remediation.timeoutMs}ms.`
        : `Commit message remediation failed: ${remediation.message}`
    );
  }
  const remediated = sanitizeCommitMessage(extractStringFieldFromJsonOutput(remediation.rawOutput, 'commitMessage'));
  if (!remediated) {
    if (!commitRegex) {
      return initial;
    }
    throw new Error('Commit message remediation returned an empty commitMessage value.');
  }
  if (commitRegex && !commitRegex.test(remediated)) {
    throw new Error(
      `Commit message remediation returned a non-compliant message. Regex: ${input.repo.commitConfig?.messageRegex}. Message: ${remediated}`
    );
  }

  return remediated;
}

function extractStringFieldFromJsonOutput(rawOutput: string | undefined, field: string) {
  const trimmed = rawOutput?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = trimmed.match(new RegExp(`"${escapedField}"\\s*:\\s*"([^"]+)"`));
    return match?.[1];
  }
}

async function proposePushBranchRemediation(input: {
  llmAdapter: ReturnType<typeof getLlmAdapter>;
  llmContext: { env: Env; sandbox: ReturnType<typeof getSandbox>; repoBoard: DurableObjectStub<RepoBoardDO>; runId: string };
  repo: Repo;
  task: Task;
  run: Awaited<ReturnType<RepoBoardDO['getRun']>>;
  cwd: string;
  model: string;
  reasoningEffort: LlmReasoningEffort;
  initialBranchName: string;
  initialError: string;
}): Promise<PushRemediationResult> {
  const prompt = [
    'A git push command failed because the remote rejected the branch name.',
    '',
    `Repository: ${input.repo.slug}`,
    `Task: ${input.task.title}`,
    `Current branch: ${input.initialBranchName}`,
    `Push error: ${input.initialError}`,
    '',
    'Return a JSON object with a single compliant replacement branch name.',
    'Rules:',
    '- Use short lowercase segments separated by `/`, `-`, or `_`.',
    '- Preserve agent context with an `agent/` prefix.',
    '- Keep total length short for strict org rules.',
    '- Include a short stable uniqueness suffix to avoid collisions.',
    '- Do not include any extra explanation outside JSON.',
    '',
    'JSON schema:',
    '{ "branchName": "string", "reason": "string (optional)" }'
  ].join('\n');

  const remediation = await input.llmAdapter.runPrompt(input.llmContext, {
    repo: input.repo,
    task: input.task,
    run: input.run,
    cwd: input.cwd,
    prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    timeoutMs: 90_000,
    phase: 'push'
  });

  if (remediation.status !== 'success') {
    const fallbackBranchName = buildFallbackPushBranchName(input.run.runId);
    return {
      branchName: fallbackBranchName,
      diagnostics:
        remediation.status === 'timed_out'
          ? `LLM remediation timed out after ${remediation.timeoutMs}ms. Falling back to deterministic branch name ${fallbackBranchName}.`
          : `${remediation.message} Falling back to deterministic branch name ${fallbackBranchName}.`
    };
  }

  const parsed = extractBranchNameFromRemediationOutput(remediation.rawOutput);
  const branchName = sanitizeBranchNameCandidate(parsed);
  if (!branchName) {
    const fallbackBranchName = buildFallbackPushBranchName(input.run.runId);
    return {
      branchName: fallbackBranchName,
      diagnostics: `LLM remediation output did not include a valid branch name. Falling back to deterministic branch name ${fallbackBranchName}. Raw output: ${summarizeOutput(remediation.rawOutput)}`
    };
  }

  return {
    branchName,
    diagnostics: 'One LLM remediation attempt completed.'
  };
}

function extractBranchNameFromRemediationOutput(rawOutput: string | undefined) {
  const trimmed = rawOutput?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as { branchName?: unknown };
    if (parsed && typeof parsed.branchName === 'string') {
      return parsed.branchName;
    }
  } catch {
    const branchMatch = trimmed.match(/"branchName"\s*:\s*"([^"]+)"/);
    if (branchMatch?.[1]) {
      return branchMatch[1];
    }

    const firstLine = trimmed.split('\n')[0]?.trim();
    if (firstLine) {
      return firstLine;
    }
  }

  return undefined;
}

function sanitizeBranchNameCandidate(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^['"]|['"]$/g, '');
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > 255) {
    return undefined;
  }
  if (
    normalized.startsWith('/')
    || normalized.endsWith('/')
    || normalized.includes('//')
    || normalized.includes('..')
    || normalized.endsWith('.')
    || normalized.includes('@{')
    || /[\s~^:?*\\[\]]/.test(normalized)
  ) {
    return undefined;
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))) {
    return undefined;
  }

  return normalized;
}

function buildFallbackPushBranchName(runId: string) {
  const hash = shortStableHash(runId).slice(0, 10);
  return `agent/run-${hash}`;
}

function isBranchPolicyPushFailure(errorMessage: string) {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes('pre-receive hook declined')
    || normalized.includes('does not follow the pattern')
    || normalized.includes('branch name')
    || normalized.includes('remote rejected')
  );
}

function formatPushFailureOutput(stderr: string | undefined, stdout: string | undefined, fallback: string) {
  const primary = stderr?.trim() || stdout?.trim();
  return primary ? primary : fallback;
}

async function appendCommandLogs(repoBoard: DurableObjectStub<RepoBoardDO>, runId: string, phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>, stdout?: string, stderr?: string) {
  const logs = [];
  if (stdout?.trim()) logs.push(buildRunLog(runId, redactSensitiveText(stdout.trim()), phase));
  if (stderr?.trim()) logs.push(buildRunLog(runId, redactSensitiveText(stderr.trim()), phase, 'error'));
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

function buildSandboxId(runId: string, role: SandboxRole) {
  const normalized = runId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  const roleTag = role === 'main' ? 'run' : role;
  const hash = shortStableHash(`${role}:${runId}`).slice(0, 8);
  const prefix = `sbx-${roleTag}-`;
  const suffix = `-${hash}`;
  const maxLength = 63;
  const maxMiddleLength = maxLength - prefix.length - suffix.length;
  const middle = maxMiddleLength > 0
    ? normalized.slice(-maxMiddleLength)
    : '';
  const id = `${prefix}${middle}${suffix}`;
  return id.slice(0, maxLength);
}

function shortStableHash(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
