import { describe, expect, it } from 'vitest';
import type { AgentRun, Task } from '../../ui/domain/types';
import { resolveRunSource } from './run-source-resolution';

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

describe('resolveRunSource', () => {
  const resolvedAt = '2026-03-02T01:00:00.000Z';

  it('prefers explicit task source refs over dependency lineage', () => {
    const upstreamTask = buildTask('task_up', { status: 'REVIEW' });
    const downstreamTask = buildTask('task_down', {
      sourceRef: 'feature/explicit',
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });
    const upstreamRun = buildRun('task_up', 'PR_OPEN', { headSha: 'a'.repeat(40), prNumber: 42 });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upstreamTask, downstreamTask],
      runs: [upstreamRun],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource).toMatchObject({
      kind: 'explicit_source_ref',
      resolvedRef: 'feature/explicit'
    });
    expect(source.dependencyContext.sourceMode).toBe('explicit_source_ref');
  });

  it('prefers explicit source override over task source ref and dependencies', () => {
    const upstreamTask = buildTask('task_up', { status: 'REVIEW' });
    const downstreamTask = buildTask('task_down', {
      sourceRef: 'feature/task-source',
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });
    const upstreamRun = buildRun('task_up', 'WAITING_PREVIEW', { headSha: 'a'.repeat(40), prNumber: 11 });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upstreamTask, downstreamTask],
      runs: [upstreamRun],
      defaultBranch: 'main',
      resolvedAt,
      sourceRefOverride: 'b'.repeat(40)
    });

    expect(source.branchSource).toMatchObject({
      kind: 'explicit_source_ref',
      resolvedRef: 'b'.repeat(40)
    });
    expect(source.dependencyContext.sourceMode).toBe('explicit_source_ref');
  });

  it('uses dependency review head when no explicit source exists', () => {
    const upstreamTask = buildTask('task_up', { status: 'REVIEW' });
    const downstreamTask = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });
    const upstreamRun = buildRun('task_up', 'WAITING_PREVIEW', { headSha: 'b'.repeat(40), prNumber: 7 });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upstreamTask, downstreamTask],
      runs: [upstreamRun],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource).toMatchObject({
      kind: 'dependency_review_head',
      upstreamTaskId: 'task_up',
      upstreamRunId: 'run_task_up',
      upstreamReviewNumber: 7,
      upstreamReviewProvider: 'github',
      upstreamPrNumber: 7,
      upstreamHeadSha: 'b'.repeat(40),
      resolvedRef: 'b'.repeat(40)
    });
    expect(source.dependencyContext).toMatchObject({
      sourceTaskId: 'task_up',
      sourceRunId: 'run_task_up',
      sourceReviewNumber: 7,
      sourceReviewProvider: 'github',
      sourcePrNumber: 7,
      sourceHeadSha: 'b'.repeat(40),
      sourceMode: 'dependency_review_head'
    });
  });

  it('falls back to default branch when multiple dependencies have no primary', () => {
    const upOne = buildTask('task_up_1', { status: 'REVIEW' });
    const upTwo = buildTask('task_up_2', { status: 'REVIEW' });
    const downstreamTask = buildTask('task_down', {
      dependencies: [
        { upstreamTaskId: 'task_up_1', mode: 'review_ready' },
        { upstreamTaskId: 'task_up_2', mode: 'review_ready' }
      ]
    });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upOne, upTwo, downstreamTask],
      runs: [
        buildRun('task_up_1', 'PR_OPEN', { headSha: 'c'.repeat(40), prNumber: 1 }),
        buildRun('task_up_2', 'PR_OPEN', { headSha: 'd'.repeat(40), prNumber: 2 })
      ],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource).toMatchObject({
      kind: 'default_branch',
      resolvedRef: 'main'
    });
    expect(source.dependencyContext.sourceMode).toBe('default_branch');
  });

  it('uses primary dependency when multiple dependencies exist', () => {
    const upOne = buildTask('task_up_1', { status: 'REVIEW' });
    const upTwo = buildTask('task_up_2', { status: 'REVIEW' });
    const downstreamTask = buildTask('task_down', {
      dependencies: [
        { upstreamTaskId: 'task_up_1', mode: 'review_ready' },
        { upstreamTaskId: 'task_up_2', mode: 'review_ready', primary: true }
      ]
    });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upOne, upTwo, downstreamTask],
      runs: [
        buildRun('task_up_1', 'PR_OPEN', { headSha: 'e'.repeat(40), prNumber: 11 }),
        buildRun('task_up_2', 'PR_OPEN', { headSha: 'f'.repeat(40), prNumber: 22 })
      ],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource).toMatchObject({
      kind: 'dependency_review_head',
      upstreamTaskId: 'task_up_2',
      upstreamReviewNumber: 22,
      upstreamPrNumber: 22,
      upstreamHeadSha: 'f'.repeat(40)
    });
    expect(source.dependencyContext.sourceTaskId).toBe('task_up_2');
  });

  it('falls back to default branch when upstream review run has no head/pr context', () => {
    const upstreamTask = buildTask('task_up', { status: 'REVIEW' });
    const downstreamTask = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upstreamTask, downstreamTask],
      runs: [buildRun('task_up', 'PR_OPEN', { prNumber: 19 })],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource.kind).toBe('default_branch');
    expect(source.dependencyContext.sourceMode).toBe('default_branch');
  });

  it('uses default branch after upstream is merged, even if review lineage metadata exists', () => {
    const upstreamTask = buildTask('task_up', { status: 'DONE' });
    const downstreamTask = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upstreamTask, downstreamTask],
      runs: [buildRun('task_up', 'DONE', { headSha: 'a'.repeat(40), prNumber: 45, prUrl: 'https://github.com/acme/repo/pull/45' })],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource.kind).toBe('default_branch');
    expect(source.branchSource.resolvedRef).toBe('main');
    expect(source.dependencyContext.sourceMode).toBe('default_branch');
  });

  it('uses default branch after a GitLab MR is merged and landed on the default branch', () => {
    const upstreamTask = buildTask('task_up', { status: 'DONE' });
    const downstreamTask = buildTask('task_down', {
      dependencies: [{ upstreamTaskId: 'task_up', mode: 'review_ready' }]
    });

    const source = resolveRunSource({
      task: downstreamTask,
      tasks: [upstreamTask, downstreamTask],
      runs: [
        buildRun('task_up', 'DONE', {
          headSha: 'b'.repeat(40),
          reviewUrl: 'https://gitlab.example.com/acme/repo/-/merge_requests/45',
          reviewNumber: 45,
          reviewProvider: 'gitlab',
          reviewState: 'merged',
          reviewMergedAt: '2026-03-02T00:45:00.000Z',
          landedOnDefaultBranch: true,
          landedOnDefaultBranchAt: '2026-03-02T00:50:00.000Z'
        })
      ],
      defaultBranch: 'main',
      resolvedAt
    });

    expect(source.branchSource.kind).toBe('default_branch');
    expect(source.branchSource.resolvedRef).toBe('main');
    expect(source.dependencyContext.sourceMode).toBe('default_branch');
  });
});
