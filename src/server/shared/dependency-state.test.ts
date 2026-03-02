import { describe, expect, it } from 'vitest';
import type { AgentRun, Task } from '../../ui/domain/types';
import { refreshDependencyStates } from './dependency-state';

function buildTask(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    taskId,
    repoId: 'repo_demo',
    title: taskId,
    taskPrompt: 'prompt',
    acceptanceCriteria: ['done'],
    context: { links: [] },
    status: 'INBOX',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildRun(taskId: string, status: AgentRun['status'], overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: `run_${taskId}`,
    taskId,
    repoId: 'repo_demo',
    status,
    branchName: `agent/${taskId}/run`,
    errors: [],
    startedAt: '2026-03-02T00:00:00.000Z',
    timeline: [{ status, at: '2026-03-02T00:00:00.000Z' }],
    simulationProfile: 'happy_path',
    pendingEvents: [],
    ...overrides
  };
}

describe('refreshDependencyStates', () => {
  it('marks downstream blocked when the upstream task is missing', () => {
    const downstream = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });
    const nowIso = '2026-03-02T01:00:00.000Z';

    const result = refreshDependencyStates([downstream], [], nowIso);
    const refreshed = result.tasks[0];

    expect(result.changedTaskIds).toEqual(['task_down']);
    expect(refreshed.dependencyState).toEqual({
      blocked: true,
      unblockedAt: undefined,
      reasons: [
        {
          upstreamTaskId: 'task_up',
          state: 'missing',
          message: 'Upstream task task_up is missing.'
        }
      ]
    });
  });

  it('unblocks dependencies when upstream task reaches review', () => {
    const upstream = buildTask('task_up', { status: 'REVIEW' });
    const downstream = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });
    const nowIso = '2026-03-02T01:05:00.000Z';

    const result = refreshDependencyStates([upstream, downstream], [], nowIso);
    const refreshed = result.tasks.find((task) => task.taskId === 'task_down')!;

    expect(refreshed.dependencyState?.blocked).toBe(false);
    expect(refreshed.dependencyState?.unblockedAt).toBe(nowIso);
    expect(refreshed.dependencyState?.reasons[0]).toMatchObject({
      upstreamTaskId: 'task_up',
      state: 'ready'
    });
  });

  it('uses latest upstream run state to mark readiness', () => {
    const upstream = buildTask('task_up', { status: 'ACTIVE' });
    const downstream = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });
    const nowIso = '2026-03-02T01:10:00.000Z';

    const result = refreshDependencyStates([upstream, downstream], [buildRun('task_up', 'WAITING_PREVIEW')], nowIso);
    const refreshed = result.tasks.find((task) => task.taskId === 'task_down')!;

    expect(refreshed.dependencyState?.blocked).toBe(false);
    expect(refreshed.dependencyState?.reasons[0]?.state).toBe('ready');
  });

  it('uses merged-to-default readiness when upstream task is done with a PR run', () => {
    const upstream = buildTask('task_up', { status: 'DONE' });
    const downstream = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });

    const result = refreshDependencyStates(
      [upstream, downstream],
      [buildRun('task_up', 'DONE', { prUrl: 'https://github.com/acme/repo/pull/10', prNumber: 10 })],
      '2026-03-02T01:15:00.000Z'
    );
    const refreshed = result.tasks.find((task) => task.taskId === 'task_down')!;

    expect(refreshed.dependencyState?.blocked).toBe(false);
    expect(refreshed.dependencyState?.reasons[0]).toMatchObject({
      upstreamTaskId: 'task_up',
      state: 'ready',
      message: 'Upstream task task_up is merged into the default branch.'
    });
  });

  it('preserves existing unblockedAt while still unblocked', () => {
    const upstream = buildTask('task_up', { status: 'REVIEW' });
    const downstream = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }],
      dependencyState: {
        blocked: false,
        unblockedAt: '2026-03-02T00:30:00.000Z',
        reasons: [{ upstreamTaskId: 'task_up', state: 'ready', message: 'old' }]
      }
    });

    const result = refreshDependencyStates([upstream, downstream], [], '2026-03-02T02:00:00.000Z');
    const refreshed = result.tasks.find((task) => task.taskId === 'task_down')!;
    expect(refreshed.dependencyState?.unblockedAt).toBe('2026-03-02T00:30:00.000Z');
  });

  it('clears unblockedAt when dependencies become blocked again', () => {
    const upstream = buildTask('task_up', { status: 'ACTIVE' });
    const downstream = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }],
      dependencyState: {
        blocked: false,
        unblockedAt: '2026-03-02T00:30:00.000Z',
        reasons: [{ upstreamTaskId: 'task_up', state: 'ready', message: 'old' }]
      }
    });

    const result = refreshDependencyStates([upstream, downstream], [], '2026-03-02T02:05:00.000Z');
    const refreshed = result.tasks.find((task) => task.taskId === 'task_down')!;
    expect(refreshed.dependencyState?.blocked).toBe(true);
    expect(refreshed.dependencyState?.unblockedAt).toBeUndefined();
    expect(refreshed.dependencyState?.reasons[0]?.state).toBe('not_ready');
  });
});
