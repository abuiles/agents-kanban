import type { RunStatus, TaskStatus } from './types';

export function canMoveTaskToStatus(taskStatus: TaskStatus, latestRunStatus: RunStatus | undefined, nextStatus: TaskStatus) {
  const hasActiveRun = latestRunStatus && !['DONE', 'FAILED'].includes(latestRunStatus);
  if (taskStatus === 'ACTIVE' && hasActiveRun && nextStatus !== 'ACTIVE') {
    return false;
  }

  return true;
}
