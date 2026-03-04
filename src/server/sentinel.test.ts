import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import type {
  Repo,
  SentinelRun,
  Task,
  TaskDetail,
  AgentRun,
  TaskStatus
} from '../ui/domain/types';
import type { ScmAdapter } from './scm/adapter';
import type { RunTransitionPatch } from './shared/real-run';
import { SentinelController, SentinelMergeEngine, SentinelSelector } from './sentinel';

type FakeSentinelBoard = {
  listTasks: MockedFunction<(tenantId?: string, options?: { tags?: string[] }) => Promise<Task[]>>;
  getTask: MockedFunction<(taskId: string, tenantId?: string) => Promise<TaskDetail>>;
  startRun: MockedFunction<(taskId: string, options?: { tenantId?: string; forceNew?: boolean; baseRunId?: string; dependencyAutoStart?: boolean }) => Promise<AgentRun>>;
  transitionRun: MockedFunction<(runId: string, patch: RunTransitionPatch) => Promise<AgentRun>>;
  updateTask: MockedFunction<(taskId: string, patch: { status: TaskStatus }) => Promise<Task>>;
};

function makeTask(partial: Partial<Task>): Task {
  return {
    taskId: partial.taskId ?? 'task_default',
    repoId: 'repo_1',
    title: 'Task',
    taskPrompt: 'Prompt',
    acceptanceCriteria: [],
    context: { links: [] },
    status: 'INBOX',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial
  } as Task;
}

function makeBaseSentinelRun(partial: Partial<SentinelRun>): SentinelRun {
  return {
    id: 'sentinel_run_1',
    tenantId: 'tenant_local',
    repoId: 'repo_1',
    scopeType: 'global',
    status: 'running',
    attemptCount: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial
  };
}

function makeTaskDetail(task: Task, latestRun?: AgentRun): TaskDetail {
  return {
    task,
    repo: {
      repoId: task.repoId,
      tenantId: task.tenantId ?? 'tenant_local',
      name: 'Repo',
      sentinelConfig: undefined
    } as unknown as TaskDetail['repo'],
    runs: latestRun ? [latestRun] : [],
    latestRun
  } as TaskDetail;
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_1',
    tenantId: 'tenant_local',
    slug: 'abuiles/minions',
    scmProvider: 'github',
    defaultBranch: 'main',
    baselineUrl: 'https://example.test',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sentinelConfig: {
      enabled: true,
      globalMode: true,
      reviewGate: { requireChecksGreen: true, requireAutoReviewPass: true },
      mergePolicy: { autoMergeEnabled: true, method: 'merge', deleteBranch: true },
      conflictPolicy: { rebaseBeforeMerge: true, remediationEnabled: true, maxAttempts: 2 }
    },
    ...overrides
  };
}

function createScmAdapter(overrides: Partial<ScmAdapter> = {}): ScmAdapter {
  return {
    provider: 'github',
    normalizeSourceRef() {
      return { kind: 'review_head', value: 'pull/1/head', label: 'PR #1', reviewNumber: 1, reviewProvider: 'github' };
    },
    inferSourceRefFromTask() {
      return undefined;
    },
    buildCloneUrl() {
      return 'git://localhost/repo.git';
    },
    createReviewRequest: vi.fn(),
    upsertRunComment: vi.fn(),
    getReviewState: vi.fn(),
    listCommitChecks: vi.fn(),
    isCommitOnDefaultBranch: vi.fn(),
    mergeReview: vi.fn(),
    ...overrides
  };
}

function createBoard(): FakeSentinelBoard {
  return {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    startRun: vi.fn(),
    transitionRun: vi.fn(),
    updateTask: vi.fn()
  };
}

function makeReviewRun(partial: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: partial.runId ?? 'run_review',
    taskId: 'task_review',
    repoId: 'repo_1',
    status: 'PR_OPEN',
    branchName: 'run-review',
    startedAt: '2026-01-01T00:00:00.000Z',
    errors: [],
    timeline: [],
    simulationProfile: 'happy_path',
    pendingEvents: [],
    reviewNumber: 7,
    headSha: 'abc123',
    ...partial
  } as AgentRun;
}

describe('SentinelSelector', () => {
  it('selects global tasks in stable order and skips DONE or dependency-blocked tasks', () => {
    const selector = new SentinelSelector();
    const tasks = [
      makeTask({
        taskId: 'task_1',
        createdAt: '2026-01-03T00:00:00.000Z',
        status: 'DONE'
      }),
      makeTask({
        taskId: 'task_2',
        createdAt: '2026-01-01T00:00:00.000Z',
        dependencyState: { blocked: true, reasons: [] }
      }),
      makeTask({
        taskId: 'task_3',
        createdAt: '2026-01-02T00:00:00.000Z',
        status: 'READY'
      }),
      makeTask({
        taskId: 'task_4',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'READY'
      })
    ];
    const result = selector.pickNextTask(tasks, { scopeType: 'global' });
    expect(result.task?.taskId).toBe('task_4');
  });

  it('selects group tasks only by matching tags', () => {
    const selector = new SentinelSelector();
    const tasks = [
      makeTask({ taskId: 'task_1', tags: ['payments'], status: 'READY', createdAt: '2026-01-02T00:00:00.000Z' }),
      makeTask({ taskId: 'task_2', tags: ['alerts'], status: 'READY', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeTask({ taskId: 'task_3', tags: ['payments'], status: 'READY', createdAt: '2026-01-01T00:00:00.000Z' })
    ];
    const result = selector.pickNextTask(tasks, { scopeType: 'group', scopeValue: 'payments' });
    expect(result.task?.taskId).toBe('task_3');
  });
});

describe('SentinelMergeEngine', () => {
  it.each([
    ['merge', false],
    ['squash', true],
    ['rebase', false]
  ] as const)('uses merge policy method=%s deleteBranch=%s', async (method, deleteBranch) => {
    const repo = makeRepo();
    const run = makeReviewRun();
    const getReviewState = vi.fn().mockResolvedValue({
      exists: true,
      state: 'open',
      headSha: 'abc123',
      mergeable: true
    });
    const listCommitChecks = vi.fn().mockResolvedValue([
      {
        status: 'completed',
        conclusion: 'success'
      }
    ]);
    const mergeReview = vi.fn().mockResolvedValue({ merged: true, mergedAt: '2026-01-02T00:00:00.000Z' });
    const adapter = createScmAdapter({ getReviewState, listCommitChecks, mergeReview });
    const engine = new SentinelMergeEngine({
      repo,
      adapter,
      now: () => '2026-01-02T00:00:00.000Z'
    });
    const result = await engine.attemptMerge(
      run,
      { requireChecksGreen: false, requireAutoReviewPass: false },
      { autoMergeEnabled: true, method, deleteBranch },
      { token: 'gh_token' }
    );

    expect(result.merged).toBe(true);
    expect(mergeReview).toHaveBeenCalledWith(repo, run, { token: 'gh_token' }, {
      method,
      deleteSourceBranch: deleteBranch
    });
  });

  it('waits on review gate when checks are not green', async () => {
    const repo = makeRepo();
    const run = makeReviewRun({
      reviewFindingsSummary: {
        total: 0,
        open: 0,
        posted: 0
      }
    });
    const getReviewState = vi.fn().mockResolvedValue({
      exists: true,
      state: 'open',
      headSha: 'abc123',
      mergeable: true
    });
    const listCommitChecks = vi.fn().mockResolvedValue([
      {
        status: 'in_progress',
        conclusion: undefined
      }
    ]);
    const mergeReview = vi.fn();
    const adapter = createScmAdapter({ getReviewState, listCommitChecks, mergeReview });
    const engine = new SentinelMergeEngine({
      repo,
      adapter,
      now: () => '2026-01-02T00:00:00.000Z'
    });

    const decision = await engine.attemptMerge(
      run,
      { requireChecksGreen: true, requireAutoReviewPass: false },
      { autoMergeEnabled: true, method: 'merge', deleteBranch: true },
      { token: 'gh_token' }
    );

    expect(decision.merged).toBe(false);
    expect(decision.reason).toContain('review gate not passed');
    expect(mergeReview).not.toHaveBeenCalled();
  });
});

describe('SentinelController', () => {
  const baseRun: SentinelRun = makeBaseSentinelRun({});
  const repo = makeRepo();
  const scmAdapter = createScmAdapter();
  let board: FakeSentinelBoard;
  let appendSentinelEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    board = createBoard();
    appendSentinelEvent = vi.fn();
    vi.clearAllMocks();
  });

  it('starts one eligible task and emits activation/start events in global scope', async () => {
    const task = makeTask({
      taskId: 'task_ready',
      tags: ['backend'],
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'READY'
    });
    board.listTasks.mockResolvedValue([task]);
    board.startRun.mockResolvedValue({
      runId: 'run_task_ready',
      taskId: task.taskId,
      repoId: task.repoId,
      status: 'RUNNING',
      branchName: 'task-ready'
    } as unknown as AgentRun);
    board.transitionRun.mockResolvedValue({} as unknown as AgentRun);
    board.updateTask.mockResolvedValue(task);

    const claimed: SentinelRun = {
      ...baseRun,
      currentTaskId: task.taskId,
      currentRunId: 'run_task_ready'
    };
    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repo,
      repoId: 'repo_1',
      scmAdapter,
      run: baseRun,
      board,
      executionContext: {} as unknown as ExecutionContext<unknown>,
      claimSentinelRunTask: vi.fn().mockResolvedValue(claimed),
      linkSentinelRunTaskId: vi.fn().mockResolvedValue(claimed),
      appendSentinelEvent,
      scheduleRun: vi.fn().mockResolvedValue({ id: 'local-alarm-run_task_ready' }),
      getScmCredential: vi.fn().mockResolvedValue({ token: 'gh_token' })
    });

    const outcome = await controller.progress();
    expect(outcome.progressed).toBe(true);
    expect(outcome.reason).toBe('started');
    expect(board.startRun).toHaveBeenCalledTimes(1);
    expect(board.transitionRun).toHaveBeenCalledTimes(1);
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'task.activated',
        sentinelRunId: baseRun.id
      })
    );
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'run.started',
        sentinelRunId: baseRun.id
      })
    );
  });

  it('blocks current REVIEW task when review gate conditions are not met', async () => {
    const reviewRun = makeReviewRun({
      reviewFindingsSummary: {
        total: 1,
        open: 2,
        posted: 0
      }
    });
    const currentTask = makeTask({ taskId: 'task_review', status: 'REVIEW' });
    const currentTaskDetail = makeTaskDetail(currentTask, reviewRun);

    const adapter = createScmAdapter({
      getReviewState: vi.fn().mockResolvedValue({
        exists: true,
        state: 'open',
        headSha: 'abc123',
        mergeable: true
      }),
      listCommitChecks: vi.fn().mockResolvedValue([
        {
          status: 'completed',
          conclusion: 'success'
        }
      ]),
      mergeReview: vi.fn()
    });

    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repo,
      repoId: 'repo_1',
      scmAdapter: adapter,
      run: makeBaseSentinelRun({
        currentTaskId: currentTask.taskId,
        currentRunId: reviewRun.runId
      }),
      board: {
        ...board,
        getTask: vi.fn().mockResolvedValue(currentTaskDetail)
      },
      executionContext: {} as unknown as ExecutionContext<unknown>,
      appendSentinelEvent,
      getScmCredential: vi.fn().mockResolvedValue({ token: 'gh_token' })
    });

    const outcome = await controller.progress();

    expect(outcome.progressed).toBe(false);
    expect(outcome.reason).toBe('blocked');
    expect(board.transitionRun).not.toHaveBeenCalled();
    expect(board.updateTask).not.toHaveBeenCalled();
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'review.gate.waiting'
      })
    );
  });

  it('marks task DONE only after merge success and emits merge success event', async () => {
    const reviewRun = makeReviewRun();
    const reviewTask = makeTask({ taskId: 'task_review', status: 'REVIEW' });
    const reviewTaskDetail = makeTaskDetail(reviewTask, reviewRun);
    const resolvedEventOrder: string[] = [];
    board.updateTask.mockImplementation(async () => {
      resolvedEventOrder.push('updateTask');
      return reviewTask;
    });
    board.transitionRun.mockImplementation(async () => {
      resolvedEventOrder.push('transitionRun');
      return reviewRun;
    });
    board.listTasks.mockResolvedValue([]);
    board.getTask.mockResolvedValue(reviewTaskDetail);

    const adapter = createScmAdapter({
      getReviewState: vi.fn().mockResolvedValue({
        exists: true,
        state: 'open',
        headSha: 'abc123',
        mergeable: true
      }),
      listCommitChecks: vi.fn().mockResolvedValue([
        {
          status: 'completed',
          conclusion: 'success'
        }
      ]),
      mergeReview: vi.fn().mockResolvedValue({
        merged: true,
        mergedAt: '2026-01-02T00:00:00.000Z'
      })
    });

    const clearSentinelRunTask = vi.fn().mockResolvedValue(makeBaseSentinelRun({}));

    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repo,
      repoId: 'repo_1',
      scmAdapter: adapter,
      run: makeBaseSentinelRun({
        currentTaskId: reviewTask.taskId,
        currentRunId: reviewRun.runId
      }),
      board,
      executionContext: {} as unknown as ExecutionContext<unknown>,
      appendSentinelEvent,
      getScmCredential: vi.fn().mockResolvedValue({ token: 'gh_token' }),
      clearSentinelRunTask,
      claimSentinelRunTask: vi.fn(),
      linkSentinelRunTaskId: vi.fn()
    });

    const outcome = await controller.progress();

    expect(outcome.progressed).toBe(false);
    expect(outcome.reason).toBe('none_available');
    expect(board.transitionRun).toHaveBeenCalledWith(
      reviewRun.runId,
      expect.objectContaining({
        status: 'DONE',
        reviewState: 'merged',
        reviewMergedAt: '2026-01-02T00:00:00.000Z'
      })
    );
    expect(board.updateTask).toHaveBeenCalledWith(reviewTask.taskId, { status: 'DONE' });
    expect(resolvedEventOrder).toEqual(['transitionRun', 'updateTask']);
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'merge.succeeded',
        sentinelRunId: baseRun.id
      })
    );
  });

  it('retries merge after remediation when initial merge attempt fails', async () => {
    const reviewRun = makeReviewRun();
    const reviewTask = makeTask({ taskId: 'task_review', status: 'REVIEW' });
    const reviewTaskDetail = makeTaskDetail(reviewTask, reviewRun);
    const getReviewState = vi.fn().mockResolvedValue({
      exists: true,
      state: 'open',
      headSha: 'abc123',
      mergeable: true
    });
    const listCommitChecks = vi.fn().mockResolvedValue([
      {
        status: 'completed',
        conclusion: 'success'
      }
    ]);
    const mergeReview = vi.fn()
      .mockResolvedValueOnce({
        merged: false,
        reason: 'merge conflict'
      })
      .mockResolvedValueOnce({
        merged: true,
        mergedAt: '2026-01-02T00:00:00.000Z'
      });
    const adapter = createScmAdapter({
      getReviewState,
      listCommitChecks,
      mergeReview
    });

    const boardAfter: FakeSentinelBoard = {
      ...board,
      getTask: vi.fn().mockResolvedValue(reviewTaskDetail),
      listTasks: vi.fn().mockResolvedValue([]),
      transitionRun: vi.fn().mockResolvedValue(reviewRun),
      updateTask: vi.fn().mockResolvedValue(reviewTask)
    };
    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repo: makeRepo({
        sentinelConfig: {
          ...(makeRepo().sentinelConfig as NonNullable<Repo['sentinelConfig']>),
          conflictPolicy: { rebaseBeforeMerge: false, remediationEnabled: true, maxAttempts: 2 }
        }
      }),
      repoId: 'repo_1',
      scmAdapter: adapter,
      run: makeBaseSentinelRun({
        currentTaskId: reviewTask.taskId,
        currentRunId: reviewRun.runId
      }),
      board: boardAfter,
      executionContext: {} as unknown as ExecutionContext<unknown>,
      appendSentinelEvent,
      getScmCredential: vi.fn().mockResolvedValue({ token: 'gh_token' }),
      claimSentinelRunTask: vi.fn(),
      linkSentinelRunTaskId: vi.fn(),
      clearSentinelRunTask: vi.fn().mockResolvedValue(makeBaseSentinelRun({}))
    });

    const outcome = await controller.progress();

    expect(outcome.progressed).toBe(false);
    expect(outcome.reason).toBe('none_available');
    expect(mergeReview).toHaveBeenCalledTimes(2);
    expect(boardAfter.transitionRun).toHaveBeenCalled();
    expect(boardAfter.updateTask).toHaveBeenCalledWith(reviewTask.taskId, { status: 'DONE' });
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'remediation.succeeded',
        sentinelRunId: baseRun.id
      })
    );
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'merge.succeeded',
        sentinelRunId: baseRun.id
      })
    );
  });

  it('advances serially to the next eligible task after current task completes', async () => {
    const finishedTask = makeTask({ taskId: 'task_done', status: 'DONE' });
    const nextTask = makeTask({
      taskId: 'task_next',
      status: 'READY',
      createdAt: '2026-01-02T00:00:00.000Z'
    });
    const blockedTask = makeTask({
      taskId: 'task_blocked',
      status: 'READY',
      createdAt: '2026-01-01T00:00:00.000Z',
      dependencyState: { blocked: true, reasons: [{ upstreamTaskId: 'task_upstream', state: 'not_ready', message: 'waiting' }] }
    });

    board.getTask.mockResolvedValue(makeTaskDetail(finishedTask));
    board.listTasks.mockResolvedValue([blockedTask, nextTask]);
    board.startRun.mockResolvedValue({
      runId: 'run_task_next',
      taskId: nextTask.taskId,
      repoId: nextTask.repoId,
      status: 'RUNNING',
      branchName: 'task-next'
    } as unknown as AgentRun);
    board.transitionRun.mockResolvedValue({} as unknown as AgentRun);

    const clearSentinelRunTask = vi.fn().mockResolvedValue(makeBaseSentinelRun({}));
    const claimSentinelRunTask = vi.fn().mockResolvedValue(makeBaseSentinelRun({
      currentTaskId: nextTask.taskId
    }));
    const linkSentinelRunTaskId = vi.fn().mockResolvedValue(makeBaseSentinelRun({
      currentTaskId: nextTask.taskId,
      currentRunId: 'run_task_next'
    }));

    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repo,
      repoId: 'repo_1',
      scmAdapter,
      run: makeBaseSentinelRun({
        currentTaskId: finishedTask.taskId,
        currentRunId: 'run_done'
      }),
      board,
      executionContext: {} as unknown as ExecutionContext<unknown>,
      appendSentinelEvent,
      clearSentinelRunTask,
      claimSentinelRunTask,
      linkSentinelRunTaskId,
      scheduleRun: vi.fn().mockResolvedValue({ id: 'local-alarm-run_task_next' }),
      getScmCredential: vi.fn().mockResolvedValue({ token: 'gh_token' })
    });

    const outcome = await controller.progress();

    expect(outcome.progressed).toBe(true);
    expect(outcome.reason).toBe('started');
    expect(clearSentinelRunTask).toHaveBeenCalledTimes(1);
    expect(claimSentinelRunTask).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_local',
      'sentinel_run_1',
      'task_next',
      undefined
    );
    expect(board.startRun).toHaveBeenCalledWith('task_next', { tenantId: 'tenant_local' });
  });

  it('tracks bounded remediation retries and pauses sentinel when exhausted', async () => {
    const reviewRun = makeReviewRun();
    const reviewTask = makeTask({ taskId: 'task_review', status: 'REVIEW' });
    const reviewTaskDetail = makeTaskDetail(reviewTask, reviewRun);
    const getReviewState = vi.fn().mockResolvedValue({
      exists: true,
      state: 'open',
      headSha: 'abc123',
      mergeable: true
    });
    const listCommitChecks = vi.fn().mockResolvedValue([
      {
        status: 'completed',
        conclusion: 'success'
      }
    ]);
    const mergeReview = vi.fn().mockResolvedValue({
      merged: false,
      reason: 'merge conflict'
    });
    const adapter = createScmAdapter({
      getReviewState,
      listCommitChecks,
      mergeReview
    });

    const updateSentinelRun = vi.fn(async (_env, _tenantId, runId, patch) => {
      return {
        ...makeBaseSentinelRun({
          id: runId,
          status: patch.status ?? 'running',
          attemptCount: patch.attemptCount ?? 0
        }),
        currentTaskId: 'task_review',
        currentRunId: reviewRun.runId
      };
    });

    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repo: makeRepo({
        sentinelConfig: {
          ...(makeRepo().sentinelConfig as NonNullable<Repo['sentinelConfig']>),
          reviewGate: { requireChecksGreen: false, requireAutoReviewPass: false },
          conflictPolicy: { rebaseBeforeMerge: false, remediationEnabled: false, maxAttempts: 1 }
        }
      }),
      repoId: 'repo_1',
      scmAdapter: adapter,
      run: makeBaseSentinelRun({
        currentTaskId: reviewTask.taskId,
        currentRunId: reviewRun.runId,
        attemptCount: 0
      }),
      board: {
        ...board,
        getTask: vi.fn().mockResolvedValue(reviewTaskDetail),
        listTasks: vi.fn(),
        transitionRun: vi.fn(),
        updateTask: vi.fn()
      },
      executionContext: {} as unknown as ExecutionContext<unknown>,
      appendSentinelEvent,
      getScmCredential: vi.fn().mockResolvedValue({ token: 'gh_token' }),
      clearSentinelRunTask: vi.fn().mockResolvedValue(makeBaseSentinelRun({ currentTaskId: reviewTask.taskId })),
      updateSentinelRun
    });

    const outcome = await controller.progress();

    expect(outcome.progressed).toBe(false);
    expect(outcome.run.status).toBe('paused');
    expect(outcome.message).toContain('after');
    expect(mergeReview).toHaveBeenCalledTimes(1);
    expect(updateSentinelRun).toHaveBeenCalledTimes(2);
    expect(updateSentinelRun).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_local',
      'sentinel_run_1',
      expect.objectContaining({
        attemptCount: 1
      })
    );
    expect(updateSentinelRun).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_local',
      'sentinel_run_1',
      expect.objectContaining({
        status: 'paused'
      })
    );
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'sentinel.paused',
        sentinelRunId: 'sentinel_run_1'
      })
    );
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'merge.failed',
        sentinelRunId: 'sentinel_run_1'
      })
    );
  });
});
