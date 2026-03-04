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

import { handleRerunReview } from './router';

function createEnv(runOverrides: Record<string, unknown> = {}): Env {
  let run = {
    runId: 'run_repo_1_demo',
    repoId: 'repo_1',
    taskId: 'task_1',
    reviewUrl: 'https://github.com/acme/demo/pull/7',
    reviewNumber: 7,
    reviewExecution: {
      enabled: true,
      trigger: 'auto_on_review',
      promptSource: 'native',
      status: 'completed',
      round: 1
    },
    ...runOverrides
  };

  const repoBoard = {
    getRun: vi.fn(async () => run),
    transitionRun: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
      run = { ...run, ...patch };
      return run;
    })
  };

  const board = {
    findRunRepoId: vi.fn(async () => 'repo_1'),
    getRepo: vi.fn(async () => ({ repoId: 'repo_1', tenantId: 'tenant_local' }))
  };

  return {
    BOARD_INDEX: {
      getByName: vi.fn(() => board)
    },
    REPO_BOARD: {
      getByName: vi.fn(() => repoBoard)
    }
  } as unknown as Env;
}

describe('handleRerunReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    orchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'wf_review_1' });
  });

  it('queues manual review rerun using review_only mode', async () => {
    const response = await handleRerunReview(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/review', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      createEnv(),
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );

    const body = await response.json() as { runId: string; workflowInstanceId?: string };

    expect(response.status).toBe(200);
    expect(orchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', runId: 'run_repo_1_demo' })
    );
    expect(body.runId).toBe('run_repo_1_demo');
    expect(body.workflowInstanceId).toBe('wf_review_1');
  });

  it('is idempotent-safe when review execution is already running', async () => {
    const env = createEnv({
      reviewExecution: {
        enabled: true,
        trigger: 'manual_rerun',
        promptSource: 'native',
        status: 'running',
        round: 2
      }
    });

    const response = await handleRerunReview(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/review', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );

    const body = await response.json() as { reviewExecution?: { status?: string; round?: number } };

    expect(response.status).toBe(200);
    expect(orchestratorMocks.scheduleRunJob).not.toHaveBeenCalled();
    expect(body.reviewExecution).toMatchObject({ status: 'running', round: 2 });
  });
});
