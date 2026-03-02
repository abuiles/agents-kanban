import type { AgentRun, RunLogEntry, RunStatus } from '../domain/types';

const messages: Record<RunStatus, string[]> = {
  QUEUED: ['Queued task and reserved a mock sandbox.'],
  BOOTSTRAPPING: ['Restoring Codex auth bundle and cloning repository.'],
  RUNNING_CODEX: [
    'Codex is reading the task prompt and repo context.',
    'Applying mock code edits based on acceptance criteria.',
    'Preparing branch for test execution.'
  ],
  OPERATOR_CONTROLLED: ['Operator took over the live sandbox session. Codex execution is paused.'],
  RUNNING_TESTS: ['Running mock test suite and static checks.'],
  PUSHING_BRANCH: ['Pushing branch to origin in the mock remote.'],
  PR_OPEN: ['Opened mock pull request and attached task summary.'],
  WAITING_PREVIEW: ['Waiting for preview deployment status checks.'],
  EVIDENCE_RUNNING: ['Running mock Playwright capture against baseline and preview.'],
  DONE: ['Run finished. Artifact manifest is ready.'],
  FAILED: ['Run failed. Check mock error details for the terminal step.']
};

export function buildLogsForStatus(run: AgentRun, status: RunStatus, createdAt: string): RunLogEntry[] {
  const lines = messages[status] ?? [];
  return lines.map((message, index) => ({
    id: `${run.runId}_${status}_${index}_${createdAt}`,
    runId: run.runId,
    createdAt,
    level: status === 'FAILED' ? 'error' : 'info',
    message
  }));
}
