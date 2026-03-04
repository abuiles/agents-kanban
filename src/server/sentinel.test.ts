import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import type { SentinelRun, Task, TaskDetail, AgentRun } from '../ui/domain/types';
import { SentinelController, SentinelSelector } from './sentinel';

type FakeSentinelBoard = {
  listTasks: MockedFunction<(tenantId?: string, options?: { tags?: string[] }) => Promise<Task[]>>;
  getTask: MockedFunction<(taskId: string, tenantId?: string) => Promise<TaskDetail>>;
  startRun: MockedFunction<(taskId: string, options?: { tenantId?: string }) => Promise<AgentRun>>;
  transitionRun: MockedFunction<
    (runId: string, patch: { workflowInstanceId: string; orchestrationMode: 'workflow' | 'local_alarm' }) => Promise<AgentRun>
  >;
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

function makeTaskDetail(task: Task): TaskDetail {
  return {
    task,
    repo: {
      repoId: task.repoId,
      tenantId: task.tenantId ?? 'tenant_local',
      name: 'Repo',
      sentinelConfig: undefined
    } as unknown as TaskDetail['repo'],
    runs: [],
    latestRun: undefined
  } as TaskDetail;
}

function createBoard(): FakeSentinelBoard {
  return {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    startRun: vi.fn(),
    transitionRun: vi.fn()
  };
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

describe('SentinelController', () => {
  const baseRun: SentinelRun = makeBaseSentinelRun({});
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

    const claimed: SentinelRun = {
      ...baseRun,
      currentTaskId: task.taskId,
      currentRunId: 'run_task_ready'
    };
    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repoId: 'repo_1',
      run: baseRun,
      board,
      executionContext: {} as unknown as ExecutionContext<unknown>,
      claimSentinelRunTask: vi.fn().mockResolvedValue(claimed),
      linkSentinelRunTaskId: vi.fn().mockResolvedValue(claimed),
      appendSentinelEvent,
      scheduleRun: vi.fn().mockResolvedValue({ id: 'local-alarm-run_task_ready' })
    });

    const outcome = await controller.progress();
    expect(outcome.progressed).toBe(true);
    expect(outcome.reason).toBe('started');
    expect(board.startRun).toHaveBeenCalledTimes(1);
    expect(board.transitionRun).toHaveBeenCalledTimes(1);
    expect(appendSentinelEvent).toHaveBeenCalledTimes(2);
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

  it('blocks when current task is still active to preserve serial scope ownership', async () => {
    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repoId: 'repo_1',
      run: makeBaseSentinelRun({ currentTaskId: 'task_active' }),
      board: {
        ...board,
        getTask: vi.fn().mockResolvedValue(makeTaskDetail(makeTask({
          taskId: 'task_active',
          status: 'ACTIVE'
        })))
      },
      executionContext: {} as unknown as ExecutionContext<unknown>,
      claimSentinelRunTask: vi.fn(),
      appendSentinelEvent,
      scheduleRun: vi.fn()
    });

    const outcome = await controller.progress();
    expect(outcome.progressed).toBe(false);
    expect(outcome.reason).toBe('blocked');
    expect(board.startRun).not.toHaveBeenCalled();
    expect(board.listTasks).not.toHaveBeenCalled();
    expect(board.transitionRun).not.toHaveBeenCalled();
    expect(appendSentinelEvent).toHaveBeenCalledTimes(1);
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'review.gate.waiting' })
    );
  });

  it('rejects progress when scope lock cannot be claimed', async () => {
    board.listTasks.mockResolvedValue([makeTask({ taskId: 'task_ready', status: 'READY' })]);
    const controller = new SentinelController({
      env: {} as Env,
      tenantId: 'tenant_local',
      repoId: 'repo_1',
      run: baseRun,
      board,
      executionContext: {} as unknown as ExecutionContext<unknown>,
      claimSentinelRunTask: vi.fn().mockResolvedValue(null),
      appendSentinelEvent
    });

    const outcome = await controller.progress();
    expect(outcome.progressed).toBe(false);
    expect(outcome.reason).toBe('conflict');
    expect(board.startRun).not.toHaveBeenCalled();
    expect(board.transitionRun).not.toHaveBeenCalled();
    expect(appendSentinelEvent).toHaveBeenCalledTimes(1);
    expect(appendSentinelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'review.gate.waiting'
      })
    );
  });
});
