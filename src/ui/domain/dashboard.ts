import type { AgentRun, RunStatus, Task, TaskStatus } from './types';

export type DashboardViewMode = 'all' | 'running' | 'review_complete' | 'attention';
export type DashboardTone = 'neutral' | 'live' | 'review' | 'success' | 'warning' | 'danger';

export type RunSignal = {
  label: string;
  detail: string;
  tone: DashboardTone;
  isLive: boolean;
};

export type ReviewSignal = {
  label: string;
  detail: string;
  tone: DashboardTone;
  isComplete: boolean;
  needsAttention: boolean;
  findingsCount: number;
};

export type DashboardStats = {
  total: number;
  visible: number;
  running: number;
  reviewComplete: number;
  attention: number;
  archived: number;
};

const LIVE_RUN_STATUSES = new Set<RunStatus>([
  'QUEUED',
  'BOOTSTRAPPING',
  'RUNNING_CODEX',
  'OPERATOR_CONTROLLED',
  'RUNNING_TESTS',
  'PUSHING_BRANCH',
  'EVIDENCE_RUNNING'
]);

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function getReviewCounts(run?: AgentRun) {
  if (run?.reviewFindingsSummary) {
    return {
      total: run.reviewFindingsSummary.total,
      open: run.reviewFindingsSummary.open
    };
  }

  const findings = run?.reviewFindings ?? [];
  return {
    total: findings.length,
    open: findings.filter((finding) => finding.status === 'open').length
  };
}

export function isTaskArchived(task: Task) {
  return Boolean(task.archived);
}

export function isRunLive(run?: AgentRun) {
  return Boolean(run && LIVE_RUN_STATUSES.has(run.status));
}

export function getRunSignal(run?: AgentRun): RunSignal {
  if (!run) {
    return { label: 'Idle', detail: 'No run started', tone: 'neutral', isLive: false };
  }

  switch (run.status) {
    case 'QUEUED':
      return { label: 'Queued', detail: 'Waiting for execution to start', tone: 'warning', isLive: true };
    case 'BOOTSTRAPPING':
      return { label: 'Bootstrapping', detail: 'Preparing sandbox and credentials', tone: 'live', isLive: true };
    case 'RUNNING_CODEX':
      return { label: 'Coding', detail: 'Executor is changing code', tone: 'live', isLive: true };
    case 'OPERATOR_CONTROLLED':
      return { label: 'Operator', detail: 'A human has taken control of the sandbox', tone: 'warning', isLive: true };
    case 'RUNNING_TESTS':
      return { label: 'Testing', detail: 'Validation is running', tone: 'live', isLive: true };
    case 'PUSHING_BRANCH':
      return { label: 'Pushing', detail: 'Branch updates are being published', tone: 'live', isLive: true };
    case 'PR_OPEN':
      return { label: 'Review open', detail: 'Waiting on review completion', tone: 'review', isLive: false };
    case 'WAITING_PREVIEW':
      return { label: 'Preview wait', detail: 'Preview discovery is still pending', tone: 'review', isLive: false };
    case 'EVIDENCE_RUNNING':
      return { label: 'Evidence', detail: 'Collecting preview artifacts and evidence', tone: 'live', isLive: true };
    case 'DONE':
      return { label: 'Done', detail: 'Latest run completed', tone: 'success', isLive: false };
    case 'FAILED':
      return { label: 'Failed', detail: 'Latest run failed', tone: 'danger', isLive: false };
    default:
      return { label: run.status, detail: 'Latest run updated', tone: 'neutral', isLive: false };
  }
}

export function getReviewSignal(run?: AgentRun): ReviewSignal {
  if (!run) {
    return {
      label: 'No review',
      detail: 'No review has started for this task',
      tone: 'neutral',
      isComplete: false,
      needsAttention: false,
      findingsCount: 0
    };
  }

  const counts = getReviewCounts(run);

  if (run.reviewExecution?.status === 'running') {
    return {
      label: 'Review running',
      detail: 'The review agent is evaluating the latest diff',
      tone: 'review',
      isComplete: false,
      needsAttention: false,
      findingsCount: counts.open || counts.total
    };
  }

  if (run.reviewExecution?.status === 'failed' || run.reviewPostState?.status === 'failed') {
    return {
      label: 'Review failed',
      detail: 'Review execution or posting failed',
      tone: 'danger',
      isComplete: false,
      needsAttention: true,
      findingsCount: counts.open || counts.total
    };
  }

  if (run.reviewExecution?.status === 'completed') {
    if (counts.open > 0) {
      return {
        label: `${counts.open} open ${pluralize(counts.open, 'finding')}`,
        detail: 'Review completed and left actionable findings',
        tone: 'danger',
        isComplete: true,
        needsAttention: true,
        findingsCount: counts.open
      };
    }

    if (counts.total > 0) {
      return {
        label: `${counts.total} ${pluralize(counts.total, 'finding')} resolved`,
        detail: 'Review completed with findings that are no longer open',
        tone: 'warning',
        isComplete: true,
        needsAttention: false,
        findingsCount: counts.total
      };
    }

    if (run.reviewState === 'merged') {
      return {
        label: 'Merged',
        detail: 'Review completed and the changes were merged',
        tone: 'success',
        isComplete: true,
        needsAttention: false,
        findingsCount: 0
      };
    }

    if (run.reviewState === 'closed') {
      return {
        label: 'Review closed',
        detail: 'Review completed and the review was closed',
        tone: 'warning',
        isComplete: true,
        needsAttention: false,
        findingsCount: 0
      };
    }

    return {
      label: 'Review passed',
      detail: 'Review completed with no open findings',
      tone: 'success',
      isComplete: true,
      needsAttention: false,
      findingsCount: 0
    };
  }

  if (run.reviewState === 'open' || run.status === 'PR_OPEN') {
    return {
      label: 'Review open',
      detail: 'A review thread exists but completion is still pending',
      tone: 'review',
      isComplete: false,
      needsAttention: false,
      findingsCount: counts.open || counts.total
    };
  }

  if (run.status === 'WAITING_PREVIEW') {
    return {
      label: 'Preview pending',
      detail: 'Review is waiting for preview discovery',
      tone: 'review',
      isComplete: false,
      needsAttention: false,
      findingsCount: counts.open || counts.total
    };
  }

  if (run.status === 'DONE') {
    return {
      label: 'Review complete',
      detail: 'The latest review flow completed',
      tone: 'success',
      isComplete: true,
      needsAttention: false,
      findingsCount: counts.open || counts.total
    };
  }

  return {
    label: 'Review pending',
    detail: 'Review has not completed yet',
    tone: 'neutral',
    isComplete: false,
    needsAttention: false,
    findingsCount: counts.open || counts.total
  };
}

export function taskNeedsAttention(task: Task, run?: AgentRun) {
  if (task.status === 'FAILED' || run?.status === 'FAILED') {
    return true;
  }

  const review = getReviewSignal(run);
  if (review.needsAttention) {
    return true;
  }

  return task.status === 'REVIEW' || run?.status === 'PR_OPEN' || run?.status === 'WAITING_PREVIEW';
}

export function filterTasksForView(tasks: Task[], runsByTask: Map<string, AgentRun>, viewMode: DashboardViewMode) {
  if (viewMode === 'all') {
    return tasks;
  }

  return tasks.filter((task) => {
    const run = runsByTask.get(task.taskId);
    if (viewMode === 'running') {
      return isRunLive(run);
    }
    if (viewMode === 'review_complete') {
      return getReviewSignal(run).isComplete;
    }
    return taskNeedsAttention(task, run);
  });
}

export function sortTasksForBoard(tasks: Task[], runsByTask: Map<string, AgentRun>) {
  function priority(task: Task, run?: AgentRun) {
    if (isRunLive(run)) return 0;
    if (taskNeedsAttention(task, run)) return 1;
    if (task.status === 'ACTIVE') return 2;
    return 3;
  }

  return [...tasks].sort((left, right) => {
    const leftRun = runsByTask.get(left.taskId);
    const rightRun = runsByTask.get(right.taskId);
    const byPriority = priority(left, leftRun) - priority(right, rightRun);
    if (byPriority !== 0) {
      return byPriority;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function getDashboardStats(
  tasks: Task[],
  archivedTasks: Task[],
  runsByTask: Map<string, AgentRun>,
  viewMode: DashboardViewMode
): DashboardStats {
  return {
    total: tasks.length,
    visible: filterTasksForView(tasks, runsByTask, viewMode).length,
    running: tasks.filter((task) => isRunLive(runsByTask.get(task.taskId))).length,
    reviewComplete: tasks.filter((task) => getReviewSignal(runsByTask.get(task.taskId)).isComplete).length,
    attention: tasks.filter((task) => taskNeedsAttention(task, runsByTask.get(task.taskId))).length,
    archived: archivedTasks.length
  };
}

export function toneClass(tone: DashboardTone) {
  switch (tone) {
    case 'live':
      return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100';
    case 'review':
      return 'border-violet-400/30 bg-violet-500/10 text-violet-100';
    case 'success':
      return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100';
    case 'warning':
      return 'border-amber-400/30 bg-amber-500/10 text-amber-100';
    case 'danger':
      return 'border-rose-400/30 bg-rose-500/10 text-rose-100';
    default:
      return 'border-slate-700 bg-slate-800/80 text-slate-200';
  }
}

export function laneStatusLabel(task: Task, run?: AgentRun) {
  if (task.archived) {
    return 'Archived';
  }
  if (isRunLive(run)) {
    return 'Running now';
  }
  if (task.status === 'REVIEW') {
    return 'In review';
  }
  if (task.status === 'DONE') {
    return 'Ready to close';
  }
  return task.status.replace('_', ' ');
}

export function getColumnHeadline(status: TaskStatus) {
  switch (status) {
    case 'ACTIVE':
      return 'Live execution and in-flight work';
    case 'REVIEW':
      return 'Review waiting, preview, and evidence states';
    case 'FAILED':
      return 'Failures, review issues, and retries';
    default:
      return undefined;
  }
}
