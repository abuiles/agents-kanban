import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../ui/domain/types';
import { deriveTaskStatusFromRun } from './task-status';

function buildRun(status: AgentRun['status'], overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run_demo',
    taskId: 'task_demo',
    repoId: 'repo_demo',
    status,
    branchName: 'agent/demo',
    errors: [],
    startedAt: '2026-03-02T00:00:00.000Z',
    timeline: [{ status, at: '2026-03-02T00:00:00.000Z' }],
    simulationProfile: 'happy_path',
    pendingEvents: [],
    ...overrides
  };
}

describe('deriveTaskStatusFromRun', () => {
  it('keeps a human-moved done task in done during review lifecycle', () => {
    expect(deriveTaskStatusFromRun(buildRun('WAITING_PREVIEW'), 'DONE')).toBe('DONE');
  });

  it('moves a task back to active when a new execution phase starts', () => {
    expect(deriveTaskStatusFromRun(buildRun('RUNNING_CODEX'), 'DONE')).toBe('ACTIVE');
  });

  it('maps failed runs with a PR back to review', () => {
    expect(deriveTaskStatusFromRun(buildRun('FAILED', { prUrl: 'https://github.com/abuiles/minions-demo/pull/5' }), 'REVIEW')).toBe('REVIEW');
  });
});
