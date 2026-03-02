import type { AgentRun, Task } from '../../ui/domain/types';

const REVIEW_READY_RUN_STATUSES: Set<AgentRun['status']> = new Set([
  'PR_OPEN',
  'WAITING_PREVIEW',
  'EVIDENCE_RUNNING',
  'DONE'
]);

export function isDependencyMergedToDefaultBranch(task: Task, latestRun: AgentRun | undefined) {
  return task.status === 'DONE' && Boolean(latestRun?.prUrl && latestRun.prNumber);
}

export function isDependencyReviewReady(task: Task, latestRun: AgentRun | undefined) {
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

export function buildLatestRunsByTaskId(runs: AgentRun[]) {
  const latestRunsByTaskId = new Map<string, AgentRun>();
  for (const run of runs) {
    const current = latestRunsByTaskId.get(run.taskId);
    if (!current || run.startedAt > current.startedAt) {
      latestRunsByTaskId.set(run.taskId, run);
    }
  }
  return latestRunsByTaskId;
}
