import type { AgentRun, Repo, RepoSentinelConfig, SentinelEventType, SentinelRun, Task, TaskDetail, TaskStatus } from '../ui/domain/types';
import { DEFAULT_REPO_SENTINEL_CONFIG, normalizeRepoSentinelConfig } from '../shared/sentinel';
import { scheduleRunJob } from './run-orchestrator';
import * as tenantAuthDb from './tenant-auth-db';
import { getRepoHost } from '../shared/scm';
import type { ScmAdapter, ScmAdapterCredential, ScmReviewState } from './scm/adapter';
import type { RunTransitionPatch } from './shared/real-run';

type RepoBoardForSentinel = {
  listTasks(tenantId?: string, options?: { tags?: string[] }): Promise<Task[]>;
  getTask(taskId: string, tenantId?: string): Promise<TaskDetail>;
  startRun(taskId: string, options?: { tenantId?: string; forceNew?: boolean; baseRunId?: string; dependencyAutoStart?: boolean }): Promise<AgentRun>;
  transitionRun(runId: string, patch: RunTransitionPatch): Promise<AgentRun>;
  updateTask(taskId: string, patch: { status: TaskStatus }): Promise<Task>;
};

const SCOPE_GLOBAL: SentinelRun['scopeType'] = 'global';
const SCOPE_GROUP: SentinelRun['scopeType'] = 'group';

export type SentinelScope = {
  scopeType: SentinelRun['scopeType'];
  scopeValue?: string;
};

export type SentinelSelectionResult = {
  task?: Task;
  reason?: string;
};

export class SentinelSelector {
  pickNextTask(tasks: Task[], scope: SentinelScope): SentinelSelectionResult {
    const matches = tasks.filter((task) => this.isEligibleTask(task, scope)).sort(this.stableOrder);
    return { task: matches[0] };
  }

  private isEligibleTask(task: Task, scope: SentinelScope): boolean {
    if (task.status === 'DONE') {
      return false;
    }
    if (task.dependencyState?.blocked === true) {
      return false;
    }
    if (scope.scopeType === SCOPE_GLOBAL) {
      return true;
    }
    if (!scope.scopeValue) {
      return false;
    }
    return (task.tags ?? []).includes(scope.scopeValue);
  }

  private stableOrder(left: Task, right: Task): number {
    const createdAtDiff = left.createdAt.localeCompare(right.createdAt);
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }
    return left.taskId.localeCompare(right.taskId);
  }
}

type ReviewGateResult = {
  passed: boolean;
  reasons: string[];
  metadata: {
    checksGreen: boolean;
    mergeable: boolean;
    openFindings: number;
    autoMergeEnabled: boolean;
    reasonSummary: string;
  };
};

type MergeAttempt = {
  merged: boolean;
  reason?: string;
  mergedAt?: string;
  gateDecision?: ReviewGateResult;
};

type MergeEngineDeps = {
  repo: Repo;
  adapter: ScmAdapter;
  now: () => string;
};

export class SentinelMergeEngine {
  private readonly repo: Repo;
  private readonly adapter: ScmAdapter;
  private readonly now: () => string;

  constructor(private readonly deps: MergeEngineDeps) {
    this.repo = deps.repo;
    this.adapter = deps.adapter;
    this.now = deps.now;
  }

  async evaluateReviewGate(
    run: AgentRun,
    reviewGate: RepoSentinelConfig['reviewGate'],
    mergePolicy: RepoSentinelConfig['mergePolicy'],
    credential: ScmAdapterCredential
  ): Promise<ReviewGateResult> {
    if (!mergePolicy.autoMergeEnabled) {
      return {
        passed: false,
        reasons: ['merge disabled by policy'],
        metadata: {
          checksGreen: false,
          mergeable: false,
          openFindings: 0,
          autoMergeEnabled: false,
          reasonSummary: 'merge disabled by policy'
        }
      };
    }

    const reviewState = await this.adapter.getReviewState(this.repo, run, credential);
    if (!reviewState.exists) {
      return {
        passed: false,
        reasons: ['review not found'],
        metadata: {
          checksGreen: false,
          mergeable: false,
          openFindings: 0,
          autoMergeEnabled: true,
          reasonSummary: 'review not found'
        }
      };
    }

    const reasons: string[] = [];
    const checksGreen = !reviewGate.requireChecksGreen || await this.areChecksGreen(reviewState, credential, reasons);
    if (!checksGreen && reviewGate.requireChecksGreen) {
      reasons.push('required checks are not green');
    }

    const mergeable = this.isMergeable(reviewState, reasons);
    if (!mergeable) {
      reasons.push('review is not mergeable');
    }

    const openFindings = this.countOpenFindings(run);
    if (reviewGate.requireAutoReviewPass && openFindings > 0) {
      reasons.push(`open auto-review findings: ${openFindings}`);
    }

    const pass = reasons.length === 0;
    if (reviewState.state !== 'open') {
      reasons.push(`review state is ${reviewState.state}`);
    }

    return {
      passed: pass && reviewState.state === 'open',
      reasons,
      metadata: {
        checksGreen,
        mergeable: reviewState.mergeable ?? mergeable,
        openFindings,
        autoMergeEnabled: true,
        reasonSummary: reasons.join('; ')
      }
    };
  }

  async attemptMerge(
    run: AgentRun,
    reviewPolicy: RepoSentinelConfig['reviewGate'],
    policy: RepoSentinelConfig['mergePolicy'],
    credential: ScmAdapterCredential
  ): Promise<MergeAttempt> {
    const reviewState = await this.adapter.getReviewState(this.repo, run, credential);
    if (reviewState.state === 'merged') {
      return {
        merged: true,
        mergedAt: reviewState.mergedAt,
        reason: 'already merged'
      };
    }
    if (reviewState.state !== 'open') {
      return {
        merged: false,
        reason: `review state is ${reviewState.state ?? 'unknown'}`
      };
    }

    const gateDecision = await this.evaluateReviewGate(run, reviewPolicy, policy, credential);
    if (!gateDecision.passed) {
      return {
        merged: false,
        reason: `review gate not passed: ${gateDecision.metadata.reasonSummary || 'unknown'}`,
        gateDecision
      };
    }

    const result = await this.adapter.mergeReview(this.repo, run, credential, {
      method: policy.method,
      deleteSourceBranch: policy.deleteBranch
    });
    if (!result.merged) {
      return {
        merged: false,
        reason: result.reason ?? 'merge request failed'
      };
    }

    return {
      merged: true,
      mergedAt: result.mergedAt ?? this.now()
    };
  }

  private countOpenFindings(run: AgentRun) {
    if (run.reviewFindingsSummary?.open !== undefined) {
      return run.reviewFindingsSummary.open;
    }
    return run.reviewFindings?.filter((finding) => finding.status === 'open').length ?? 0;
  }

  private async areChecksGreen(
    reviewState: ScmReviewState,
    credential: ScmAdapterCredential,
    reasons: string[]
  ) {
    if (!reviewState.headSha) {
      reasons.push('missing review head SHA for checks');
      return false;
    }
    const checks = await this.adapter.listCommitChecks(this.repo, reviewState.headSha, credential);
    if (checks.length === 0) {
      reasons.push('no commit checks found');
      return false;
    }
    return checks.every((check) => {
      if (check.status !== 'completed') {
        return false;
      }
      if (check.conclusion === undefined) {
        return false;
      }
      return check.conclusion === 'success' || check.conclusion === 'neutral' || check.conclusion === 'skipped';
    });
  }

  private isMergeable(reviewState: ScmReviewState, reasons: string[]) {
    if (reviewState.mergeable === undefined) {
      reasons.push('mergeability unknown');
      return false;
    }
    return reviewState.mergeable;
  }
}

type RemediationAttempt = {
  kind: 'merge' | 'rebase' | 'remediation';
  attempt: number;
  succeeded: boolean;
  merged: boolean;
  reason?: string;
  mergedAt?: string;
};

type RemediationFlowOutcome = {
  status: 'merged' | 'blocked' | 'retry' | 'exhausted';
  mergedAt?: string;
  reason?: string;
  gateDecision?: ReviewGateResult;
  attemptCount: number;
  steps: RemediationAttempt[];
};

type RemediationEngineDeps = {
  repo: Repo;
  adapter: ScmAdapter;
  mergeEngine: SentinelMergeEngine;
  now: () => string;
};

export class SentinelRemediationEngine {
  private readonly repo: Repo;
  private readonly adapter: ScmAdapter;
  private readonly mergeEngine: SentinelMergeEngine;
  private readonly now: () => string;

  constructor(private readonly deps: RemediationEngineDeps) {
    this.repo = deps.repo;
    this.adapter = deps.adapter;
    this.mergeEngine = deps.mergeEngine;
    this.now = deps.now;
  }

  async runWithPolicy(
    run: AgentRun,
    reviewPolicy: RepoSentinelConfig['reviewGate'],
    mergePolicy: RepoSentinelConfig['mergePolicy'],
    conflictPolicy: RepoSentinelConfig['conflictPolicy'],
    credential: ScmAdapterCredential,
    startingAttemptCount: number
  ): Promise<RemediationFlowOutcome> {
    const steps: RemediationAttempt[] = [];
    const maxAttempts = Math.max(1, Math.floor(Number(conflictPolicy.maxAttempts) || 1));

    for (let attempt = startingAttemptCount + 1; attempt <= maxAttempts; attempt += 1) {
      const mergeAttempt = await this.mergeEngine.attemptMerge(run, reviewPolicy, mergePolicy, credential);
      steps.push({
        kind: 'merge',
        attempt,
        succeeded: mergeAttempt.merged,
        merged: mergeAttempt.merged,
        reason: mergeAttempt.reason ?? 'merge failed',
        mergedAt: mergeAttempt.mergedAt ?? this.now()
      });

      if (mergeAttempt.merged) {
        return {
          status: 'merged',
          mergedAt: mergeAttempt.mergedAt,
          attemptCount: attempt,
          steps
        };
      }

      if (mergeAttempt.reason?.startsWith('review gate not passed')) {
        return {
          status: 'blocked',
          reason: mergeAttempt.reason,
          gateDecision: mergeAttempt.gateDecision,
          attemptCount: startingAttemptCount,
          steps
        };
      }

      if (attempt >= maxAttempts) {
        return {
          status: 'exhausted',
          reason: mergeAttempt.reason ?? 'merge retry limit reached',
          attemptCount: attempt,
          steps
        };
      }

      if (conflictPolicy.rebaseBeforeMerge) {
        const rebaseAttempt = await this.attemptRebaseMerge(run, credential, attempt, mergePolicy.deleteBranch);
        steps.push(rebaseAttempt);
        if (rebaseAttempt.merged) {
          return {
            status: 'merged',
            mergedAt: rebaseAttempt.mergedAt,
            attemptCount: attempt,
            steps
          };
        }
      }

      if (conflictPolicy.remediationEnabled) {
        const remediationAttempt = await this.runRemediationPlan(run, attempt, credential);
        steps.push(remediationAttempt);
      }
    }

    return {
      status: 'exhausted',
      reason: 'merge retry limit reached',
      attemptCount: startingAttemptCount,
      steps
    };
  }

  private async attemptRebaseMerge(
    run: AgentRun,
    credential: ScmAdapterCredential,
    attempt: number,
    deleteSourceBranch: boolean
  ): Promise<RemediationAttempt> {
    const result = await this.mergeEngine.attemptMerge(run, {
      requireChecksGreen: false,
      requireAutoReviewPass: false
    }, {
      autoMergeEnabled: true,
      method: 'rebase',
      deleteBranch: deleteSourceBranch
    }, credential);
    return {
      kind: 'rebase',
      attempt,
      succeeded: result.merged,
      merged: result.merged,
      reason: result.reason ?? 'rebase before merge failed',
      mergedAt: result.mergedAt ?? this.now()
    };
  }

  private async runRemediationPlan(
    run: AgentRun,
    attempt: number,
    credential: ScmAdapterCredential
  ): Promise<RemediationAttempt> {
    const reviewState = await this.adapter.getReviewState(this.repo, run, credential);
    if (!reviewState.exists) {
      return {
        kind: 'remediation',
        attempt,
        succeeded: false,
        merged: false,
        reason: 'review no longer available for remediation'
      };
    }
    return {
      kind: 'remediation',
      attempt,
      succeeded: true,
      merged: false,
      reason: 'remediation strategy executed'
    };
  }
}

type ClaimSentinelRunTask = (
  env: Env,
  tenantId: string,
  runId: string,
  taskId: string,
  taskRunId: string | undefined
) => Promise<SentinelRun | null>;

type ClearSentinelRunTask = (env: Env, tenantId: string, runId: string) => Promise<SentinelRun>;

type LinkSentinelRunTaskId = (env: Env, tenantId: string, runId: string, taskRunId: string) => Promise<SentinelRun>;

type UpdateSentinelRun = (
  env: Env,
  tenantId: string,
  runId: string,
  patch: {
    status?: SentinelRun['status'];
    currentTaskId?: string;
    currentRunId?: string;
    attemptCount?: number;
    updatedAt?: string;
  }
) => Promise<SentinelRun>;

type AppendSentinelEvent = (env: Env, input: {
  tenantId: string;
  repoId: string;
  sentinelRunId: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  type: SentinelEventType;
  message: string;
  metadata?: Record<string, string | number | boolean>;
}) => Promise<unknown>;

type ResolveScmCredential = (env: Env, repo: Repo, adapter: ScmAdapter) => Promise<ScmAdapterCredential>;

type ScheduleRun = typeof scheduleRunJob;

type SentinelControllerDeps = {
  env: Env;
  tenantId: string;
  repo: Repo;
  repoId: string;
  scmAdapter: ScmAdapter;
  run: SentinelRun;
  board: RepoBoardForSentinel;
  executionContext: ExecutionContext<unknown>;
  getScmCredential?: ResolveScmCredential;
  now?: () => string;
  selector?: SentinelSelector;
  claimSentinelRunTask?: ClaimSentinelRunTask;
  clearSentinelRunTask?: ClearSentinelRunTask;
  updateSentinelRun?: UpdateSentinelRun;
  linkSentinelRunTaskId?: LinkSentinelRunTaskId;
  appendSentinelEvent?: AppendSentinelEvent;
  scheduleRun?: ScheduleRun;
};

export type SentinelProgressOutcome = {
  run: SentinelRun;
  progressed: boolean;
  reason: 'not_running' | 'blocked' | 'started' | 'none_available' | 'conflict';
  message?: string;
};

export class SentinelController {
  private readonly now: () => string;
  private readonly selector: SentinelSelector;
  private readonly repo: Repo;
  private readonly scmAdapter: ScmAdapter;
  private readonly claimSentinelRunTask: ClaimSentinelRunTask;
  private readonly clearSentinelRunTask: ClearSentinelRunTask;
  private readonly linkSentinelRunTaskId: LinkSentinelRunTaskId;
  private readonly updateSentinelRun: UpdateSentinelRun;
  private readonly appendSentinelEvent: AppendSentinelEvent;
  private readonly scheduleRun: ScheduleRun;
  private readonly mergeEngine: SentinelMergeEngine;
  private readonly remediationEngine: SentinelRemediationEngine;
  private readonly resolveScmCredential: ResolveScmCredential;

  constructor(private readonly deps: SentinelControllerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.selector = deps.selector ?? new SentinelSelector();
    this.repo = normalizeRepoSentinelConfig(deps.repo);
    this.scmAdapter = deps.scmAdapter;
    this.claimSentinelRunTask = deps.claimSentinelRunTask ?? tenantAuthDb.claimSentinelRunTask;
    this.clearSentinelRunTask = deps.clearSentinelRunTask ?? this.createClearCurrentTaskFn(deps.env);
    this.linkSentinelRunTaskId = deps.linkSentinelRunTaskId ?? this.createLinkTaskRunFn(deps.env);
    this.appendSentinelEvent = deps.appendSentinelEvent ?? createAppendEventFn(deps.env);
    this.updateSentinelRun = deps.updateSentinelRun ?? tenantAuthDb.updateSentinelRun;
    this.scheduleRun = deps.scheduleRun ?? scheduleRunJob;
    this.resolveScmCredential = deps.getScmCredential ?? resolveScmCredentialFromEnv;
    this.mergeEngine = new SentinelMergeEngine({
      repo: this.repo,
      adapter: this.scmAdapter,
      now: this.now
    });
    this.remediationEngine = new SentinelRemediationEngine({
      repo: this.repo,
      adapter: this.scmAdapter,
      mergeEngine: this.mergeEngine,
      now: this.now
    });
  }

  async progress(): Promise<SentinelProgressOutcome> {
    let run = this.deps.run;
    if (run.status !== 'running') {
      return { run, progressed: false, reason: 'not_running', message: `Sentinel run ${run.id} is not running.` };
    }

    const currentScope = { scopeType: run.scopeType, scopeValue: run.scopeValue };

    if (run.currentTaskId) {
      const decision = await this.resolveCurrentTaskState(run);
      if (!decision.canProgress) {
        return {
          run: decision.run,
          progressed: false,
          reason: 'blocked',
          message: decision.reason
        };
      }
      run = decision.run;
    }

    const candidateTasks = await this.deps.board.listTasks(this.deps.tenantId, currentScope.scopeType === SCOPE_GROUP
      ? currentScope.scopeValue ? { tags: [currentScope.scopeValue] } : undefined
      : undefined
    );
    const selection = this.selector.pickNextTask(candidateTasks, currentScope);
    if (!selection.task) {
      const reason = selection.reason ?? `No eligible tasks available for ${currentScope.scopeType} scope.`;
      await this.emitEvent(run, 'review.gate.waiting', `Sentinel has no eligible tasks to start for ${currentScope.scopeType} scope.`, { reason });
      return { run, progressed: false, reason: 'none_available', message: String(reason) };
    }

    const claimed = await this.claimSentinelRunTask(this.deps.env, this.deps.tenantId, run.id, selection.task.taskId, undefined);
    if (!claimed) {
      await this.emitEvent(run, 'review.gate.waiting', `Sentinel could not acquire scope lock for scope ${currentScope.scopeType}.`, {
        reason: 'scope_conflict',
        scopeTaskId: run.currentTaskId ?? ''
      });
      return {
        run,
        progressed: false,
        reason: 'conflict',
        message: 'Scope lock was already acquired by another controller.'
      };
    }
    run = claimed;

    try {
      await this.emitEvent(run, 'task.activated', `Sentinel activated task ${selection.task.taskId}.`, {
        taskId: selection.task.taskId,
        scopeType: run.scopeType,
        scopeValue: run.scopeValue ?? ''
      });

      const runForTask = await this.deps.board.startRun(selection.task.taskId, { tenantId: this.deps.tenantId });
      run = await this.linkSentinelRunTaskId(this.deps.env, this.deps.tenantId, run.id, runForTask.runId);

      const workflow = await this.scheduleRun(this.deps.env, this.deps.executionContext, {
        tenantId: this.deps.tenantId,
        repoId: this.deps.repoId,
        taskId: selection.task.taskId,
        runId: runForTask.runId,
        mode: 'full_run'
      });
      await this.deps.board.transitionRun(runForTask.runId, {
        workflowInstanceId: workflow.id,
        orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
      });
      await this.emitEvent(run, 'run.started', `Sentinel started run ${runForTask.runId} for task ${selection.task.taskId}.`, {
        taskId: selection.task.taskId,
        runId: runForTask.runId
      });
      return { run, progressed: true, reason: 'started', message: selection.task.taskId };
    } catch (error) {
      run = await this.clearSentinelRunTask(this.deps.env, this.deps.tenantId, run.id);
      const reason = error instanceof Error ? error.message : 'unknown_error';
      await this.emitEvent(run, 'review.gate.waiting', `Sentinel could not start task ${selection.task.taskId}.`, {
        taskId: selection.task.taskId,
        reason
      });
      throw error;
    }
  }

  private async resolveCurrentTaskState(run: SentinelRun): Promise<{ run: SentinelRun; canProgress: boolean; reason?: string }> {
    const currentTaskId = run.currentTaskId;
    if (!currentTaskId) {
      return { run, canProgress: true };
    }

    const currentTask = await this.deps.board.getTask(currentTaskId, this.deps.tenantId).catch(() => undefined);
      if (!currentTask) {
        const cleared = await this.clearSentinelRunTask(this.deps.env, this.deps.tenantId, run.id);
        await this.emitEvent(run, 'review.gate.waiting', `Sentinel current task ${currentTaskId} is missing; scope lock released.`, {
          taskId: currentTaskId,
          scopeType: run.scopeType,
        scopeValue: run.scopeValue ?? ''
      });
      return { run: cleared, canProgress: true, reason: 'current task missing' };
    }

    if (currentTask.task.status === 'DONE') {
      const cleared = await this.clearSentinelRunTask(this.deps.env, this.deps.tenantId, run.id);
      return {
        run: cleared,
        canProgress: true,
        reason: `Current task ${currentTaskId} completed; scope lock released.`
      };
    }

    const reviewPolicy = this.repo.sentinelConfig?.reviewGate ?? DEFAULT_REPO_SENTINEL_CONFIG.reviewGate;
    const mergePolicy = this.repo.sentinelConfig?.mergePolicy ?? DEFAULT_REPO_SENTINEL_CONFIG.mergePolicy;
    const conflictPolicy = this.repo.sentinelConfig?.conflictPolicy ?? DEFAULT_REPO_SENTINEL_CONFIG.conflictPolicy;

    if (currentTask.task.status === 'REVIEW') {
      const currentRun = this.resolveCurrentRun(currentTask, run.currentRunId);
      if (!currentRun) {
        await this.emitEvent(run, 'review.gate.waiting', `Sentinel current review task ${currentTask.task.taskId} has no run reference.`, {
          taskId: currentTask.task.taskId,
          taskStatus: currentTask.task.status
        });
        return { run, canProgress: false, reason: 'Current review task has no active run reference.' };
      }

      try {
        const mergeCredential = await this.resolveScmCredential(this.deps.env, this.repo, this.scmAdapter);
        const mergeOutcome = await this.remediationEngine.runWithPolicy(
          currentRun,
          reviewPolicy,
          mergePolicy,
          conflictPolicy,
          mergeCredential,
          run.attemptCount
        );

        await this.emitRemediationEvents(run, currentTask.task.taskId, currentRun.runId, mergeOutcome);

      if (mergeOutcome.status === 'blocked') {
          await this.emitEvent(run, 'review.gate.waiting', `Sentinel blocked by review gate for task ${currentTask.task.taskId}.`, {
            taskId: currentTask.task.taskId,
            runId: currentRun.runId,
            reason: mergeOutcome.reason ?? 'review gate not passed',
            reviewGateAutoMergeEnabled: mergeOutcome.gateDecision?.metadata.autoMergeEnabled ?? false,
            reviewGateChecksGreen: mergeOutcome.gateDecision?.metadata.checksGreen ?? false,
            reviewGateMergeable: mergeOutcome.gateDecision?.metadata.mergeable ?? false,
            reviewGateOpenFindings: mergeOutcome.gateDecision?.metadata.openFindings ?? 0,
            reviewGateReasons: mergeOutcome.gateDecision?.metadata.reasonSummary ?? ''
          });
          return {
            run,
            canProgress: false,
            reason: mergeOutcome.reason ?? `Current task ${currentTaskId} is waiting on review gate.`
          };
        }

        if (mergeOutcome.status === 'merged') {
          await this.deps.board.transitionRun(currentRun.runId, {
            status: 'DONE',
            reviewState: 'merged',
            reviewMergedAt: mergeOutcome.mergedAt,
            appendTimelineNote: 'Sentinel merge succeeded.'
          });
          await this.deps.board.updateTask(currentTask.task.taskId, { status: 'DONE' });
          const cleared = await this.clearSentinelRunTask(this.deps.env, this.deps.tenantId, run.id);
          await this.emitEvent(cleared, 'merge.succeeded', `Sentinel merged review for task ${currentTask.task.taskId}.`, {
            taskId: currentTask.task.taskId,
            runId: currentRun.runId,
            method: mergePolicy.method,
            deleteBranch: mergePolicy.deleteBranch,
            attempts: mergeOutcome.attemptCount
          });
          return {
            run: cleared,
            canProgress: true,
            reason: `Current task ${currentTaskId} was merged and marked done.`
          };
        }

        const updated = await this.updateAttemptCount(run, mergeOutcome.attemptCount);
        if (mergeOutcome.status === 'exhausted') {
          const pauseReason = `Sentinel paused while processing task ${currentTask.task.taskId} after ${mergeOutcome.attemptCount}/${conflictPolicy.maxAttempts} merge attempts.`;
          return this.pauseSentinel(updated, pauseReason);
        }

        return {
          run: updated,
          canProgress: false,
          reason: mergeOutcome.reason ?? `Current task ${currentTaskId} merge retrying.`
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown_error';
        await this.emitEvent(run, 'merge.failed', `Sentinel merge attempt failed for task ${currentTask.task.taskId}.`, {
          taskId: currentTask.task.taskId,
          runId: currentRun.runId,
          reason
        });
        return { run, canProgress: false, reason: `Current task ${currentTaskId} merge failed.` };
      }
    }

    await this.emitEvent(run, 'review.gate.waiting', `Sentinel scope is blocked by task ${currentTask.task.taskId}.`, {
      taskId: currentTask.task.taskId,
      taskStatus: currentTask.task.status,
      scopeType: run.scopeType
    });
    return { run, canProgress: false, reason: `Current task ${currentTaskId} is still active in scope.` };
  }

  private resolveCurrentRun(currentTask: TaskDetail, currentRunId?: string): AgentRun | undefined {
    if (currentRunId) {
      const viaId = currentTask.runs.find((entry) => entry.runId === currentRunId);
      if (viaId) {
        return viaId;
      }
    }
    return currentTask.latestRun;
  }

  private async emitEvent(run: SentinelRun, type: SentinelEventType, message: string, metadata?: Record<string, string | number | boolean>) {
    const at = this.now();
    const level = type === 'merge.failed' || type === 'remediation.failed' || type === 'sentinel.paused'
      ? 'error'
      : type === 'review.gate.waiting'
        ? 'warn'
        : 'info';
    await this.appendSentinelEvent(this.deps.env, {
      tenantId: this.deps.tenantId,
      repoId: this.deps.repoId,
      sentinelRunId: run.id,
      at,
      level,
      type,
      message,
      metadata
    });
  }

  private async emitRemediationEvents(
    run: SentinelRun,
    taskId: string,
    taskRunId: string,
    outcome: RemediationFlowOutcome
  ) {
    const baseMetadata = {
      taskId,
      runId: taskRunId,
      attemptCount: outcome.attemptCount
    };

    for (const step of outcome.steps) {
      if (step.kind === 'merge') {
        if (step.succeeded && step.merged) {
          await this.emitEvent(run, 'merge.succeeded', `Sentinel merge attempt ${step.attempt} succeeded for task ${taskId}.`, {
            ...baseMetadata,
            attempt: step.attempt,
            result: 'success'
          });
          continue;
        }
        await this.emitEvent(run, 'merge.attempted', `Sentinel attempted merge for task ${taskId} (attempt ${step.attempt}).`, {
          ...baseMetadata,
          attempt: step.attempt,
          result: 'failure',
          reason: step.reason ?? 'unknown'
        });
        await this.emitEvent(run, 'merge.failed', `Sentinel merge attempt for task ${taskId} failed.`, {
          ...baseMetadata,
          attempt: step.attempt,
          reason: step.reason ?? 'unknown'
        });
        continue;
      }

      if (step.kind === 'rebase') {
        await this.emitEvent(run, 'remediation.started', `Sentinel rebase-before-merge started for task ${taskId}.`, {
          ...baseMetadata,
          attempt: step.attempt,
          reason: step.reason ?? 'unknown'
        });
        if (step.succeeded && step.merged) {
          await this.emitEvent(run, 'remediation.succeeded', `Sentinel rebase-before-merge succeeded for task ${taskId}.`, {
            ...baseMetadata,
            attempt: step.attempt,
            reason: step.reason ?? 'unknown'
          });
          continue;
        }
        await this.emitEvent(run, 'remediation.failed', `Sentinel rebase-before-merge for task ${taskId} failed.`, {
          ...baseMetadata,
          attempt: step.attempt,
          reason: step.reason ?? 'unknown'
        });
        continue;
      }

      if (step.succeeded) {
        await this.emitEvent(run, 'remediation.started', `Sentinel remediation started for task ${taskId}.`, {
          ...baseMetadata,
          attempt: step.attempt,
          reason: step.reason ?? 'unknown'
        });
        await this.emitEvent(run, 'remediation.succeeded', `Sentinel remediation step succeeded for task ${taskId}.`, {
          ...baseMetadata,
          attempt: step.attempt,
          reason: step.reason ?? 'unknown'
        });
        continue;
      }

      await this.emitEvent(run, 'remediation.failed', `Sentinel remediation step failed for task ${taskId}.`, {
        ...baseMetadata,
        attempt: step.attempt,
        reason: step.reason ?? 'unknown'
      });
    }
  }

  private async pauseSentinel(run: SentinelRun, reason: string): Promise<{ run: SentinelRun; canProgress: boolean; reason: string }> {
    const paused = await this.updateSentinelRun(this.deps.env, this.deps.tenantId, run.id, {
      status: 'paused',
      updatedAt: this.now()
    });
    await this.emitEvent(paused, 'sentinel.paused', `Sentinel paused while processing task ${run.currentTaskId}.`, {
      taskId: run.currentTaskId ?? '',
      reason
    });
    return { run: paused, canProgress: false, reason };
  }

  private async updateAttemptCount(run: SentinelRun, attemptCount: number): Promise<SentinelRun> {
    if (run.attemptCount === attemptCount) {
      return run;
    }
    return this.updateSentinelRun(this.deps.env, this.deps.tenantId, run.id, {
      attemptCount,
      updatedAt: this.now()
    });
  }

  private createClearCurrentTaskFn(env: Env): ClearSentinelRunTask {
    return (_env, tenantId, runId) => tenantAuthDb.updateSentinelRun(env, tenantId, runId, {
      currentTaskId: undefined,
      currentRunId: undefined,
      attemptCount: 0,
      updatedAt: this.now()
    });
  }

  private createLinkTaskRunFn(env: Env): LinkSentinelRunTaskId {
    return (_env, tenantId, runId, taskRunId) => tenantAuthDb.updateSentinelRun(env, tenantId, runId, {
      currentRunId: taskRunId,
      updatedAt: this.now()
    });
  }
}

function createAppendEventFn(env: Env): AppendSentinelEvent {
  return (_env, input) => tenantAuthDb.appendSentinelEvent(env, {
    tenantId: input.tenantId,
    repoId: input.repoId,
    sentinelRunId: input.sentinelRunId,
    at: input.at,
    level: input.level,
    type: input.type,
    message: input.message,
    metadata: input.metadata
  });
}

async function resolveScmCredentialFromEnv(env: Env, repo: Repo, adapter: ScmAdapter): Promise<ScmAdapterCredential> {
  const runtimeEnv = env as Env & { GITHUB_TOKEN?: string; GITLAB_TOKEN?: string };
  if (adapter.provider === 'github' && runtimeEnv.GITHUB_TOKEN?.trim()) {
    return { token: runtimeEnv.GITHUB_TOKEN.trim() };
  }
  if (adapter.provider === 'gitlab' && runtimeEnv.GITLAB_TOKEN?.trim()) {
    return { token: runtimeEnv.GITLAB_TOKEN.trim() };
  }

  throw new Error(
    `Missing ${adapter.provider === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'} secret for provider ${adapter.provider} host ${getRepoHost(repo)}.`
  );
}
