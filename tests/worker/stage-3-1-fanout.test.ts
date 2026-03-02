import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AgentRun, Repo, Task } from '../../src/ui/domain/types';

function taskInput(repoId: string, title: string, status: Task['status'] = 'INBOX') {
  return {
    repoId,
    title,
    taskPrompt: `${title} prompt`,
    acceptanceCriteria: [`${title} done`],
    context: { links: [] },
    status
  };
}

async function createRepo(slug: string): Promise<Repo> {
  const board = env.BOARD_INDEX.getByName('agentboard');
  return board.createRepo({
    slug,
    baselineUrl: `https://${slug}.example.com`,
    defaultBranch: 'main'
  });
}

function sha(char: string) {
  return char.repeat(40);
}

describe('Stage 3.1 fanout integration', () => {
  it('auto-starts A dependents B/C from review lineage and remains idempotent on repeated fanout signals', async () => {
    const repo = await createRepo('fanout-e2e');
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);

    const taskA = await repoBoard.createTask(taskInput(repo.repoId, 'A', 'READY'));
    const taskB = await repoBoard.createTask(taskInput(repo.repoId, 'B'));
    const taskC = await repoBoard.createTask(taskInput(repo.repoId, 'C'));

    await repoBoard.updateTask(taskB.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: true }
    });
    await repoBoard.updateTask(taskC.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: true }
    });

    const runA = await repoBoard.startRun(taskA.taskId);
    await repoBoard.transitionRun(runA.runId, {
      status: 'PR_OPEN',
      prNumber: 101,
      headSha: sha('a')
    });

    const detailB = await repoBoard.getTask(taskB.taskId);
    const detailC = await repoBoard.getTask(taskC.taskId);
    expect(detailB.task.status).toBe('ACTIVE');
    expect(detailC.task.status).toBe('ACTIVE');
    expect(detailB.latestRun?.dependencyContext).toMatchObject({
      sourceMode: 'dependency_review_head',
      sourceTaskId: taskA.taskId,
      sourceRunId: runA.runId,
      sourceReviewNumber: 101,
      sourceReviewProvider: 'github',
      sourcePrNumber: 101,
      sourceHeadSha: sha('a')
    });
    expect(detailC.latestRun?.dependencyContext).toMatchObject({
      sourceMode: 'dependency_review_head',
      sourceTaskId: taskA.taskId,
      sourceRunId: runA.runId,
      sourceReviewNumber: 101,
      sourceReviewProvider: 'github',
      sourcePrNumber: 101,
      sourceHeadSha: sha('a')
    });

    const firstBRunId = detailB.latestRun?.runId;
    const firstCRunId = detailC.latestRun?.runId;

    await repoBoard.transitionRun(runA.runId, {
      status: 'WAITING_PREVIEW',
      prNumber: 101,
      headSha: sha('a')
    });

    const detailBAfter = await repoBoard.getTask(taskB.taskId);
    const detailCAfter = await repoBoard.getTask(taskC.taskId);
    expect(detailBAfter.latestRun?.runId).toBe(firstBRunId);
    expect(detailCAfter.latestRun?.runId).toBe(firstCRunId);

    const slice = await repoBoard.getBoardSlice();
    expect(slice.runs.filter((run) => run.taskId === taskB.taskId)).toHaveLength(1);
    expect(slice.runs.filter((run) => run.taskId === taskC.taskId)).toHaveLength(1);
  });

  it('runs canonical A->B/C->D/E dogfood flow with primary lineage and merge-to-default fallback', async () => {
    const repo = await createRepo('dogfood-e2e');
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);

    const taskA = await repoBoard.createTask(taskInput(repo.repoId, 'A', 'READY'));
    const taskB = await repoBoard.createTask(taskInput(repo.repoId, 'B', 'INBOX'));
    const taskC = await repoBoard.createTask(taskInput(repo.repoId, 'C', 'INBOX'));
    const taskD = await repoBoard.createTask(taskInput(repo.repoId, 'D', 'READY'));
    const taskE = await repoBoard.createTask(taskInput(repo.repoId, 'E', 'INBOX'));

    await repoBoard.updateTask(taskB.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: true }
    });
    await repoBoard.updateTask(taskC.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: true }
    });
    await repoBoard.updateTask(taskD.taskId, {
      dependencies: [
        { upstreamTaskId: taskB.taskId, mode: 'review_ready' },
        { upstreamTaskId: taskC.taskId, mode: 'review_ready' }
      ],
      automationState: { autoStartEligible: true }
    });
    await repoBoard.updateTask(taskE.taskId, {
      dependencies: [
        { upstreamTaskId: taskB.taskId, mode: 'review_ready' },
        { upstreamTaskId: taskC.taskId, mode: 'review_ready', primary: true }
      ],
      automationState: { autoStartEligible: true }
    });

    const runA = await repoBoard.startRun(taskA.taskId);
    await repoBoard.transitionRun(runA.runId, {
      status: 'PR_OPEN',
      prNumber: 201,
      headSha: sha('b')
    });

    const runB = (await repoBoard.getTask(taskB.taskId)).latestRun as AgentRun;
    const runC = (await repoBoard.getTask(taskC.taskId)).latestRun as AgentRun;
    expect(runB?.dependencyContext?.sourceMode).toBe('dependency_review_head');
    expect(runC?.dependencyContext?.sourceMode).toBe('dependency_review_head');

    await repoBoard.transitionRun(runB.runId, {
      status: 'PR_OPEN',
      prNumber: 202,
      headSha: sha('c')
    });
    await repoBoard.transitionRun(runC.runId, {
      status: 'PR_OPEN',
      prNumber: 203,
      headSha: sha('d')
    });

    const detailDPreMerge = await repoBoard.getTask(taskD.taskId);
    const detailEPreMerge = await repoBoard.getTask(taskE.taskId);
    expect(detailDPreMerge.latestRun).toBeUndefined();
    expect(detailEPreMerge.latestRun?.dependencyContext).toMatchObject({
      sourceMode: 'dependency_review_head',
      sourceTaskId: taskC.taskId,
      sourceRunId: runC.runId,
      sourceReviewNumber: 203,
      sourceReviewProvider: 'github',
      sourcePrNumber: 203,
      sourceHeadSha: sha('d')
    });

    await repoBoard.transitionRun(runB.runId, {
      status: 'DONE',
      prNumber: 202,
      prUrl: 'https://github.com/acme/repo/pull/202',
      headSha: sha('c')
    });
    await repoBoard.transitionRun(runC.runId, {
      status: 'DONE',
      prNumber: 203,
      prUrl: 'https://github.com/acme/repo/pull/203',
      headSha: sha('d')
    });
    await repoBoard.updateTask(taskB.taskId, { status: 'DONE' });
    await repoBoard.updateTask(taskC.taskId, { status: 'DONE' });

    const detailDPostMerge = await repoBoard.getTask(taskD.taskId);
    expect(detailDPostMerge.task.status).toBe('ACTIVE');
    expect(detailDPostMerge.latestRun?.dependencyContext?.sourceMode).toBe('default_branch');
    expect(detailDPostMerge.task.branchSource).toMatchObject({ kind: 'default_branch', resolvedRef: 'main' });

    const detailEPostMerge = await repoBoard.getTask(taskE.taskId);
    const eRunCount = (await repoBoard.getBoardSlice()).runs.filter((run) => run.taskId === taskE.taskId).length;
    expect(detailEPostMerge.latestRun?.dependencyContext?.sourceMode).toBe('dependency_review_head');
    expect(eRunCount).toBe(1);
  });

  it('allows GitLab MRs to drive review fanout and merged-to-default fallback', async () => {
    const board = env.BOARD_INDEX.getByName('agentboard');
    const repo = await board.createRepo({
      slug: 'group/project',
      projectPath: 'group/project',
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      baselineUrl: 'https://gitlab-fanout.example.com',
      defaultBranch: 'main'
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);

    const taskA = await repoBoard.createTask(taskInput(repo.repoId, 'A', 'READY'));
    const taskB = await repoBoard.createTask(taskInput(repo.repoId, 'B', 'INBOX'));
    const taskC = await repoBoard.createTask(taskInput(repo.repoId, 'C', 'READY'));

    await repoBoard.updateTask(taskB.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: true }
    });
    await repoBoard.updateTask(taskC.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: false }
    });

    const runA = await repoBoard.startRun(taskA.taskId);
    await repoBoard.transitionRun(runA.runId, {
      status: 'PR_OPEN',
      reviewUrl: 'https://gitlab.example.com/group/project/-/merge_requests/301',
      reviewNumber: 301,
      reviewProvider: 'gitlab',
      reviewState: 'open',
      headSha: sha('g')
    });

    const detailB = await repoBoard.getTask(taskB.taskId);
    expect(detailB.task.status).toBe('ACTIVE');
    expect(detailB.latestRun?.dependencyContext).toMatchObject({
      sourceMode: 'dependency_review_head',
      sourceTaskId: taskA.taskId,
      sourceRunId: runA.runId,
      sourceReviewNumber: 301,
      sourceReviewProvider: 'gitlab',
      sourceHeadSha: sha('g')
    });

    await repoBoard.transitionRun(runA.runId, {
      status: 'DONE',
      reviewUrl: 'https://gitlab.example.com/group/project/-/merge_requests/301',
      reviewNumber: 301,
      reviewProvider: 'gitlab',
      reviewState: 'merged',
      reviewMergedAt: '2026-03-02T01:00:00.000Z',
      landedOnDefaultBranch: true,
      landedOnDefaultBranchAt: '2026-03-02T01:05:00.000Z',
      headSha: sha('g')
    });
    await repoBoard.updateTask(taskA.taskId, { status: 'DONE' });
    await repoBoard.updateTask(taskC.taskId, {
      automationState: { autoStartEligible: true }
    });

    const detailC = await repoBoard.getTask(taskC.taskId);
    expect(detailC.task.status).toBe('ACTIVE');
    expect(detailC.latestRun?.dependencyContext?.sourceMode).toBe('default_branch');
    expect(detailC.task.branchSource).toMatchObject({ kind: 'default_branch', resolvedRef: 'main' });
  });

  it('allows provider-neutral GitHub review metadata to drive review fanout and merged-to-default fallback', async () => {
    const repo = await createRepo('github-provider-neutral');
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);

    const taskA = await repoBoard.createTask(taskInput(repo.repoId, 'A', 'READY'));
    const taskB = await repoBoard.createTask(taskInput(repo.repoId, 'B', 'INBOX'));
    const taskC = await repoBoard.createTask(taskInput(repo.repoId, 'C', 'READY'));

    await repoBoard.updateTask(taskB.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: true }
    });
    await repoBoard.updateTask(taskC.taskId, {
      dependencies: [{ upstreamTaskId: taskA.taskId, mode: 'review_ready' }],
      automationState: { autoStartEligible: false }
    });

    const runA = await repoBoard.startRun(taskA.taskId);
    await repoBoard.transitionRun(runA.runId, {
      status: 'PR_OPEN',
      reviewUrl: 'https://github.com/acme/github-provider-neutral/pull/401',
      reviewNumber: 401,
      reviewProvider: 'github',
      reviewState: 'open',
      headSha: sha('h')
    });

    const detailB = await repoBoard.getTask(taskB.taskId);
    expect(detailB.task.status).toBe('ACTIVE');
    expect(detailB.latestRun?.dependencyContext).toMatchObject({
      sourceMode: 'dependency_review_head',
      sourceTaskId: taskA.taskId,
      sourceRunId: runA.runId,
      sourceReviewNumber: 401,
      sourceReviewProvider: 'github',
      sourceHeadSha: sha('h')
    });

    await repoBoard.transitionRun(runA.runId, {
      status: 'DONE',
      reviewUrl: 'https://github.com/acme/github-provider-neutral/pull/401',
      reviewNumber: 401,
      reviewProvider: 'github',
      reviewState: 'merged',
      reviewMergedAt: '2026-03-02T02:00:00.000Z',
      landedOnDefaultBranch: true,
      landedOnDefaultBranchAt: '2026-03-02T02:05:00.000Z',
      headSha: sha('h')
    });
    await repoBoard.updateTask(taskA.taskId, { status: 'DONE' });
    await repoBoard.updateTask(taskC.taskId, {
      automationState: { autoStartEligible: true }
    });

    const detailC = await repoBoard.getTask(taskC.taskId);
    expect(detailC.task.status).toBe('ACTIVE');
    expect(detailC.latestRun?.dependencyContext?.sourceMode).toBe('default_branch');
    expect(detailC.task.branchSource).toMatchObject({ kind: 'default_branch', resolvedRef: 'main' });
  });
});
