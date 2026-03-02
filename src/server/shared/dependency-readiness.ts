import type { AgentRun, Task } from '../../ui/domain/types';
import { getRunReviewNumber, getRunReviewProvider, hasRunReview } from '../../shared/scm';

const REVIEW_READY_RUN_STATUSES: Set<AgentRun['status']> = new Set([
  'PR_OPEN',
  'WAITING_PREVIEW',
  'EVIDENCE_RUNNING',
  'DONE'
]);

export function isDependencyMergedToDefaultBranch(task: Task, latestRun: AgentRun | undefined) {
  if (task.status !== 'DONE' || !latestRun || !hasRunReview(latestRun)) {
    return false;
  }

  // Provider-neutral merge readiness is explicit once review state/default-branch
  // reachability have been resolved through the SCM adapter layer.
  if (latestRun.reviewState || typeof latestRun.landedOnDefaultBranch === 'boolean') {
    return latestRun.reviewState === 'merged' && latestRun.landedOnDefaultBranch === true;
  }

  // Preserve existing GitHub Stage 3.1 behavior for legacy runs that only stored PR metadata.
  return getRunReviewProvider(latestRun) === 'github' && Boolean(getRunReviewNumber(latestRun));
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

  return latestRun.status === 'FAILED' && hasRunReview(latestRun);
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
