import { describe, expect, it } from 'vitest';
import type { Task } from '../../ui/domain/types';
import { applyRunTransition, createRealRun } from './real-run';

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    tenantId: 'tenant_default',
    taskId: 'task_repo_demo_1',
    repoId: 'repo_demo',
    title: 'Implement feature',
    taskPrompt: 'Do the work',
    acceptanceCriteria: ['Done'],
    context: { links: [] },
    status: 'INBOX',
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    ...overrides
  };
}

describe('real run checkpoint metadata compatibility', () => {
  it('keeps checkpoint metadata optional for backward compatibility', () => {
    const run = createRealRun(buildTask(), 'run_1', new Date('2026-03-04T00:00:00.000Z'));
    expect(run.checkpoints).toBeUndefined();
    expect(run.resumedFromCheckpointId).toBeUndefined();
    expect(run.resumedFromCommitSha).toBeUndefined();
  });

  it('accepts checkpoint metadata when creating runs', () => {
    const run = createRealRun(buildTask(), 'run_2', new Date('2026-03-04T00:00:00.000Z'), {
      resumedFromCheckpointId: 'cp_1',
      resumedFromCommitSha: 'a'.repeat(40),
      checkpoints: [{
        checkpointId: 'cp_1',
        runId: 'run_2',
        repoId: 'repo_demo',
        taskId: 'task_repo_demo_1',
        phase: 'codex',
        commitSha: 'a'.repeat(40),
        commitMessage: 'checkpoint: codex',
        createdAt: '2026-03-04T00:00:00.000Z'
      }]
    });

    expect(run.resumedFromCheckpointId).toBe('cp_1');
    expect(run.resumedFromCommitSha).toBe('a'.repeat(40));
    expect(run.checkpoints).toHaveLength(1);
    expect(run.checkpoints?.[0]?.phase).toBe('codex');
  });

  it('preserves checkpoint metadata through run transitions', () => {
    const initial = createRealRun(buildTask(), 'run_3', new Date('2026-03-04T00:00:00.000Z'));
    const updated = applyRunTransition(initial, {
      checkpoints: [{
        checkpointId: 'cp_2',
        runId: 'run_3',
        repoId: 'repo_demo',
        taskId: 'task_repo_demo_1',
        phase: 'tests',
        commitSha: 'b'.repeat(40),
        commitMessage: 'checkpoint: tests',
        createdAt: '2026-03-04T00:10:00.000Z'
      }],
      resumedFromCheckpointId: 'cp_1',
      resumedFromCommitSha: 'a'.repeat(40)
    }, '2026-03-04T00:10:00.000Z');

    expect(updated.checkpoints).toHaveLength(1);
    expect(updated.checkpoints?.[0]?.checkpointId).toBe('cp_2');
    expect(updated.resumedFromCheckpointId).toBe('cp_1');
    expect(updated.resumedFromCommitSha).toBe('a'.repeat(40));
  });
});
