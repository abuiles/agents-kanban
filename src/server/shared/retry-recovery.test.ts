import { describe, expect, it } from 'vitest';
import type { AgentRun, RunCheckpoint } from '../../ui/domain/types';
import { resolveRetryRecoveryDecision } from './retry-recovery';

function buildCheckpoint(sequence: number, overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  const commitSha = `${sequence}`.repeat(40).slice(0, 40);
  return {
    checkpointId: `run_1:cp:${String(sequence).padStart(3, '0')}:codex`,
    runId: 'run_1',
    repoId: 'repo_1',
    taskId: 'task_1',
    phase: 'codex',
    commitSha,
    commitMessage: `checkpoint ${sequence}`,
    createdAt: `2026-03-02T00:00:0${sequence}.000Z`,
    ...overrides
  };
}

function buildRun(checkpoints?: RunCheckpoint[]): Pick<AgentRun, 'checkpoints'> {
  return { checkpoints };
}

describe('resolveRetryRecoveryDecision', () => {
  it('defaults to latest checkpoint recovery when input is omitted', () => {
    const decision = resolveRetryRecoveryDecision(buildRun([
      buildCheckpoint(1),
      buildCheckpoint(2)
    ]));

    expect(decision.strategy).toBe('checkpoint');
    if (decision.strategy !== 'checkpoint') {
      return;
    }
    expect(decision.resumedFromCheckpointId).toBe('run_1:cp:002:codex');
    expect(decision.timelineNote).toContain('latest checkpoint run_1:cp:002:codex');
  });

  it('supports explicit checkpoint selection by checkpointId', () => {
    const first = buildCheckpoint(1);
    const second = buildCheckpoint(2);
    const decision = resolveRetryRecoveryDecision(buildRun([first, second]), {
      recoveryMode: 'latest_checkpoint',
      checkpointId: first.checkpointId
    });

    expect(decision.strategy).toBe('checkpoint');
    if (decision.strategy !== 'checkpoint') {
      return;
    }
    expect(decision.resumedFromCheckpointId).toBe(first.checkpointId);
    expect(decision.resumedFromCommitSha).toBe(first.commitSha);
    expect(decision.timelineNote).toContain(first.checkpointId);
  });

  it('falls back to fresh mode with deterministic note when explicit checkpoint is missing', () => {
    const decision = resolveRetryRecoveryDecision(buildRun([buildCheckpoint(1)]), {
      recoveryMode: 'latest_checkpoint',
      checkpointId: 'missing-checkpoint'
    });

    expect(decision).toMatchObject({
      strategy: 'fresh',
      timelineNote: 'Checkpoint recovery unavailable (reason=checkpoint_not_found, checkpointId=missing-checkpoint); falling back to fresh retry from standard source resolution.'
    });
  });

  it('falls back to fresh mode with deterministic note when no checkpoints exist', () => {
    const decision = resolveRetryRecoveryDecision(buildRun([]));

    expect(decision).toMatchObject({
      strategy: 'fresh',
      timelineNote: 'Checkpoint recovery unavailable (reason=no_checkpoints); falling back to fresh retry from standard source resolution.'
    });
  });
});
