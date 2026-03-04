import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Stage 8.1 checkpoint recovery hardening', () => {
  it('retries from the latest usable checkpoint and records provenance fields', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/checkpoint-hardening',
      baselineUrl: 'https://checkpoint-hardening.example.com',
      defaultBranch: 'main'
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const task = await repoBoard.createTask({
      repoId: repo.repoId,
      title: 'Checkpoint lifecycle',
      taskPrompt: 'Validate retry-from-checkpoint behavior.',
      acceptanceCriteria: ['latest checkpoint is selected deterministically'],
      context: { links: [] },
      status: 'READY'
    });
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.transitionRun(run.runId, {
      status: 'FAILED',
      checkpoints: [
        {
          checkpointId: `${run.runId}:cp:001:codex`,
          runId: run.runId,
          repoId: run.repoId,
          taskId: run.taskId,
          phase: 'codex',
          commitSha: 'a'.repeat(40),
          commitMessage: `agentskanban checkpoint 001 (codex) [${run.runId}]`,
          createdAt: '2026-03-02T00:00:05.000Z'
        },
        {
          checkpointId: `${run.runId}:cp:002:tests`,
          runId: run.runId,
          repoId: run.repoId,
          taskId: run.taskId,
          phase: 'tests',
          commitSha: 'b'.repeat(40),
          commitMessage: `agentskanban checkpoint 002 (tests) [${run.runId}]`,
          createdAt: '2026-03-02T00:00:01.000Z'
        },
        {
          checkpointId: `${run.runId}:cp:002:tests`,
          runId: run.runId,
          repoId: run.repoId,
          taskId: run.taskId,
          phase: 'tests',
          commitSha: 'c'.repeat(40),
          commitMessage: `agentskanban checkpoint 002 (tests) [${run.runId}]`,
          createdAt: '2026-03-02T00:00:09.000Z'
        },
        {
          checkpointId: `${run.runId}:cp:003:push`,
          runId: run.runId,
          repoId: run.repoId,
          taskId: run.taskId,
          phase: 'push',
          commitSha: 'not-a-real-sha',
          commitMessage: `agentskanban checkpoint 003 (push) [${run.runId}]`,
          createdAt: '2026-03-02T00:00:10.000Z'
        }
      ]
    });

    const retried = await repoBoard.retryRun(run.runId, { tenantId: repo.tenantId });
    const detail = await repoBoard.getTask(task.taskId);

    expect(retried.baseRunId).toBe(run.runId);
    expect(retried.resumedFromCheckpointId).toBe(`${run.runId}:cp:002:tests`);
    expect(retried.resumedFromCommitSha).toBe('c'.repeat(40));
    expect(retried.timeline.some((entry) => entry.note?.includes(`latest checkpoint ${run.runId}:cp:002:tests`))).toBe(true);
    expect(detail.task.branchSource).toMatchObject({
      kind: 'explicit_source_ref',
      resolvedRef: 'c'.repeat(40)
    });
  });

  it('falls back to fresh retry and omits resume provenance when explicit checkpoint is missing', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'acme/checkpoint-fallback',
      baselineUrl: 'https://checkpoint-fallback.example.com',
      defaultBranch: 'main'
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const task = await repoBoard.createTask({
      repoId: repo.repoId,
      title: 'Checkpoint fallback',
      taskPrompt: 'Ensure missing checkpoint ids fall back safely.',
      acceptanceCriteria: ['fallback is deterministic'],
      context: { links: [] },
      status: 'READY'
    });
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.transitionRun(run.runId, {
      status: 'FAILED',
      checkpoints: [
        {
          checkpointId: `${run.runId}:cp:001:codex`,
          runId: run.runId,
          repoId: run.repoId,
          taskId: run.taskId,
          phase: 'codex',
          commitSha: 'd'.repeat(40),
          commitMessage: `agentskanban checkpoint 001 (codex) [${run.runId}]`,
          createdAt: '2026-03-02T00:00:05.000Z'
        }
      ]
    });

    const retried = await repoBoard.retryRun(run.runId, {
      tenantId: repo.tenantId,
      recoveryMode: 'latest_checkpoint',
      checkpointId: 'missing-checkpoint'
    });
    const detail = await repoBoard.getTask(task.taskId);

    expect(retried.resumedFromCheckpointId).toBeUndefined();
    expect(retried.resumedFromCommitSha).toBeUndefined();
    expect(retried.timeline.some((entry) => entry.note?.includes('reason=checkpoint_not_found'))).toBe(true);
    expect(detail.task.branchSource).toMatchObject({
      kind: 'default_branch',
      resolvedRef: 'main'
    });
  });
});
