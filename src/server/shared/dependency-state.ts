import type { AgentRun, Task, TaskAutomationState, TaskDependencyReason, TaskDependencyState } from '../../ui/domain/types';

type RefreshDependencyStatesResult = {
  tasks: Task[];
  changedTaskIds: string[];
};

const REVIEW_READY_RUN_STATUSES: Set<AgentRun['status']> = new Set([
  'PR_OPEN',
  'WAITING_PREVIEW',
  'EVIDENCE_RUNNING',
  'DONE'
]);

export function refreshDependencyStates(tasks: Task[], runs: AgentRun[], nowIso: string): RefreshDependencyStatesResult {
  if (!tasks.length) {
    return { tasks, changedTaskIds: [] };
  }

  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const latestRunsByTaskId = buildLatestRunsByTaskId(runs);
  const changedTaskIds: string[] = [];

  const nextTasks = tasks.map((task) => {
    if (!task.dependencies?.length) {
      return task;
    }

    const dependencyState = buildDependencyState(task, tasksById, latestRunsByTaskId, nowIso);
    const automationState = buildAutomationState(task.automationState, nowIso);
    if (
      areDependencyStatesEqual(task.dependencyState, dependencyState)
      && areAutomationStatesEqual(task.automationState, automationState)
    ) {
      return task;
    }

    changedTaskIds.push(task.taskId);
    return {
      ...task,
      dependencyState,
      automationState,
      updatedAt: nowIso
    };
  });

  if (!changedTaskIds.length) {
    return { tasks, changedTaskIds };
  }

  return { tasks: nextTasks, changedTaskIds };
}

function buildLatestRunsByTaskId(runs: AgentRun[]) {
  const latestRunsByTaskId = new Map<string, AgentRun>();
  for (const run of runs) {
    const current = latestRunsByTaskId.get(run.taskId);
    if (!current || run.startedAt > current.startedAt) {
      latestRunsByTaskId.set(run.taskId, run);
    }
  }
  return latestRunsByTaskId;
}

function buildDependencyState(
  task: Task,
  tasksById: Map<string, Task>,
  latestRunsByTaskId: Map<string, AgentRun>,
  nowIso: string
): TaskDependencyState {
  const reasons: TaskDependencyReason[] = task.dependencies!.map((dependency) => {
    const upstreamTask = tasksById.get(dependency.upstreamTaskId);
    if (!upstreamTask) {
      return {
        upstreamTaskId: dependency.upstreamTaskId,
        state: 'missing',
        message: `Upstream task ${dependency.upstreamTaskId} is missing.`
      };
    }

    const upstreamRun = latestRunsByTaskId.get(dependency.upstreamTaskId);
    if (isReviewReady(upstreamTask, upstreamRun)) {
      return {
        upstreamTaskId: dependency.upstreamTaskId,
        state: 'ready',
        message: `Upstream task ${dependency.upstreamTaskId} is review-ready.`
      };
    }

    return {
      upstreamTaskId: dependency.upstreamTaskId,
      state: 'not_ready',
      message: `Upstream task ${dependency.upstreamTaskId} is not review-ready yet.`
    };
  });
  const blocked = reasons.some((reason) => reason.state !== 'ready');

  return {
    blocked,
    unblockedAt: blocked ? undefined : (task.dependencyState?.unblockedAt ?? nowIso),
    reasons
  };
}

function buildAutomationState(automationState: TaskAutomationState | undefined, nowIso: string) {
  if (!automationState) {
    return undefined;
  }
  return {
    ...automationState,
    lastDependencyRefreshAt: nowIso
  };
}

function isReviewReady(task: Task, latestRun: AgentRun | undefined) {
  if (task.status === 'REVIEW' || task.status === 'DONE') {
    return true;
  }

  if (!latestRun) {
    return false;
  }

  if (REVIEW_READY_RUN_STATUSES.has(latestRun.status)) {
    return true;
  }

  return latestRun.status === 'FAILED' && Boolean(latestRun.prUrl);
}

function areDependencyStatesEqual(left: TaskDependencyState | undefined, right: TaskDependencyState | undefined) {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (left.blocked !== right.blocked || left.unblockedAt !== right.unblockedAt || left.reasons.length !== right.reasons.length) {
    return false;
  }

  for (let index = 0; index < left.reasons.length; index += 1) {
    const leftReason = left.reasons[index];
    const rightReason = right.reasons[index];
    if (
      leftReason.upstreamTaskId !== rightReason.upstreamTaskId
      || leftReason.state !== rightReason.state
      || leftReason.message !== rightReason.message
    ) {
      return false;
    }
  }

  return true;
}

function areAutomationStatesEqual(left: TaskAutomationState | undefined, right: TaskAutomationState | undefined) {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.autoStartEligible === right.autoStartEligible
    && left.autoStartedAt === right.autoStartedAt
    && left.lastDependencyRefreshAt === right.lastDependencyRefreshAt;
}
