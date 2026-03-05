import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  resolveSessionByToken: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  getTenantMembership: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn()
}));

const orchestratorMocks = vi.hoisted(() => ({
  scheduleRunJob: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);
vi.mock('./run-orchestrator', () => orchestratorMocks);

import { handleRunTask } from './router';

function createEnv(options: { sourceRef?: string | undefined; reviewOnly?: boolean } = {}): {
  env: Env;
  repoBoard: { transitionRun: ReturnType<typeof vi.fn> };
} {
  let run = {
    runId: 'run_1',
    taskId: 'task_1',
    repoId: 'repo_1',
    branchName: 'agent/task_1/run_1'
  };
  const sourceRef = options.sourceRef ?? 'refs/merge-requests/12/head';

  const repoBoard = {
    getTask: vi.fn(async () => ({
      task: {
        taskId: 'task_1',
        repoId: 'repo_1',
        title: 'Review task',
        taskPrompt: 'Review only',
        acceptanceCriteria: ['Post findings'],
        context: { links: [] },
        sourceRef,
        tags: options.reviewOnly ? ['review_only'] : undefined,
        status: 'REVIEW',
        tenantId: 'tenant_local',
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z'
      }
    })),
    startRun: vi.fn(async () => run),
    transitionRun: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
      run = { ...run, ...patch };
      return run;
    }),
    getRun: vi.fn(async () => run)
  };

  const board = {
    findTaskRepoId: vi.fn(async () => 'repo_1'),
    getRepo: vi.fn(async () => ({
      repoId: 'repo_1',
      tenantId: 'tenant_local',
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'acme/demo',
      defaultBranch: 'main',
      baselineUrl: 'https://app.example.com',
      enabled: true,
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z'
    }))
  };

  return {
    env: {
      BOARD_INDEX: {
        getByName: vi.fn(() => board)
      },
      REPO_BOARD: {
        getByName: vi.fn(() => repoBoard)
      }
    } as unknown as Env,
    repoBoard
  };
}

describe('handleRunTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    orchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'wf_1' });
  });

  it('schedules review-only mode for review-only tasks', async () => {
    const { env, repoBoard } = createEnv({ reviewOnly: true });
    const response = await handleRunTask(
      new Request('https://minions.example.test/api/tasks/task_1/run', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { taskId: 'task_1' },
      {} as ExecutionContext<unknown>
    );

    expect(response.status).toBe(200);
    expect(orchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', runId: 'run_1' })
    );
    expect(repoBoard.transitionRun).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({
        status: 'PR_OPEN',
        branchName: 'refs/merge-requests/12/head',
        reviewProvider: 'gitlab',
        reviewNumber: 12
      }),
      'tenant_local'
    );
  });

  it('rejects review-only runs when sourceRef is missing', async () => {
    const { env } = createEnv({ reviewOnly: true, sourceRef: '' });
    const response = await handleRunTask(
      new Request('https://minions.example.test/api/tasks/task_1/run', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { taskId: 'task_1' },
      {} as ExecutionContext<unknown>
    );

    expect(response.status).toBe(400);
    expect(orchestratorMocks.scheduleRunJob).not.toHaveBeenCalled();
  });
});
