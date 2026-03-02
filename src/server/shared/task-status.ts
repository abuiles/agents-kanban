import type { AgentRun, TaskStatus } from '../../ui/domain/types';

export function deriveTaskStatusFromRun(run: AgentRun, current: TaskStatus): TaskStatus {
  if (current === 'DONE' && !isExecutionPhase(run.status)) {
    return 'DONE';
  }

  if (run.status === 'PR_OPEN' || run.status === 'WAITING_PREVIEW' || run.status === 'EVIDENCE_RUNNING' || run.status === 'DONE') {
    return 'REVIEW';
  }
  if (run.status === 'FAILED') {
    return run.prUrl ? 'REVIEW' : 'FAILED';
  }
  if (isExecutionPhase(run.status)) {
    return 'ACTIVE';
  }
  return current;
}

function isExecutionPhase(status: AgentRun['status']) {
  return status === 'QUEUED' || status === 'BOOTSTRAPPING' || status === 'RUNNING_CODEX' || status === 'RUNNING_TESTS' || status === 'PUSHING_BRANCH';
}
