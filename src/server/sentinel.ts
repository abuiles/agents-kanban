import type { AgentRun, SentinelEventType, SentinelRun, Task, TaskDetail } from '../ui/domain/types';
import { scheduleRunJob } from './run-orchestrator';
import * as tenantAuthDb from './tenant-auth-db';

type RepoBoardForSentinel = {
  listTasks(tenantId?: string, options?: { tags?: string[] }): Promise<Task[]>;
  getTask(taskId: string, tenantId?: string): Promise<TaskDetail>;
  startRun(taskId: string, options?: { tenantId?: string; forceNew?: boolean; baseRunId?: string; dependencyAutoStart?: boolean }): Promise<AgentRun>;
  transitionRun(runId: string, patch: {
    workflowInstanceId: string;
    orchestrationMode: 'workflow' | 'local_alarm';
  }): Promise<AgentRun>;
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

type ClaimSentinelRunTask = (
  env: Env,
  tenantId: string,
  runId: string,
  taskId: string,
  taskRunId: string | undefined
) => Promise<SentinelRun | null>;

type ClearSentinelRunTask = (env: Env, tenantId: string, runId: string) => Promise<SentinelRun>;

type LinkSentinelRunTaskId = (env: Env, tenantId: string, runId: string, taskRunId: string) => Promise<SentinelRun>;

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

type ScheduleRun = typeof scheduleRunJob;

type SentinelControllerDeps = {
  env: Env;
  tenantId: string;
  repoId: string;
  run: SentinelRun;
  board: RepoBoardForSentinel;
  executionContext: ExecutionContext<unknown>;
  now?: () => string;
  selector?: SentinelSelector;
  claimSentinelRunTask?: ClaimSentinelRunTask;
  clearSentinelRunTask?: ClearSentinelRunTask;
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
  private readonly claimSentinelRunTask: ClaimSentinelRunTask;
  private readonly clearSentinelRunTask: ClearSentinelRunTask;
  private readonly linkSentinelRunTaskId: LinkSentinelRunTaskId;
  private readonly appendSentinelEvent: AppendSentinelEvent;
  private readonly scheduleRun: ScheduleRun;

  constructor(private readonly deps: SentinelControllerDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.selector = deps.selector ?? new SentinelSelector();
    this.claimSentinelRunTask = deps.claimSentinelRunTask ?? tenantAuthDb.claimSentinelRunTask;
    this.clearSentinelRunTask = deps.clearSentinelRunTask ?? this.createClearCurrentTaskFn(deps.env);
    this.linkSentinelRunTaskId = deps.linkSentinelRunTaskId ?? this.createLinkTaskRunFn(deps.env);
    this.appendSentinelEvent = deps.appendSentinelEvent ?? createAppendEventFn(deps.env);
    this.scheduleRun = deps.scheduleRun ?? scheduleRunJob;
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

    await this.emitEvent(run, 'review.gate.waiting', `Sentinel scope is blocked by task ${currentTask.task.taskId}.`, {
      taskId: currentTask.task.taskId,
      taskStatus: currentTask.task.status,
      scopeType: run.scopeType
    });
    return { run, canProgress: false, reason: `Current task ${currentTaskId} is still active in scope.` };
  }

  private async emitEvent(run: SentinelRun, type: SentinelEventType, message: string, metadata?: Record<string, string | number | boolean>) {
    const at = this.now();
    await this.appendSentinelEvent(this.deps.env, {
      tenantId: this.deps.tenantId,
      repoId: this.deps.repoId,
      sentinelRunId: run.id,
      at,
      level: type === 'review.gate.waiting' ? 'warn' : 'info',
      type,
      message,
      metadata
    });
  }

  private createClearCurrentTaskFn(env: Env): ClearSentinelRunTask {
    return (_env, tenantId, runId) => tenantAuthDb.updateSentinelRun(env, tenantId, runId, {
      currentTaskId: undefined,
      currentRunId: undefined,
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
