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

import { handleRetryRun } from './router';

function createEnv(): { env: Env; repoBoard: { retryRun: ReturnType<typeof vi.fn> } } {
  let run = {
    runId: 'run_retry_2',
    taskId: 'task_1',
    repoId: 'repo_1'
  };

  const repoBoard = {
    retryRun: vi.fn(async (_runId: string, _input: Record<string, unknown>) => run),
    transitionRun: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
      run = { ...run, ...patch };
      return run;
    }),
    getRun: vi.fn(async () => run)
  };

  const board = {
    findRunRepoId: vi.fn(async () => 'repo_1'),
    getRepo: vi.fn(async () => ({
      repoId: 'repo_1',
      tenantId: 'tenant_local',
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com',
      projectPath: 'acme/demo'
    }))
  };

  const env = {
    BOARD_INDEX: {
      getByName: vi.fn(() => board)
    },
    REPO_BOARD: {
      getByName: vi.fn(() => repoBoard)
    }
  } as unknown as Env;

  return { env, repoBoard };
}

describe('handleRetryRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    orchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'wf_retry_1' });
  });

  it('defaults retry requests to latest_checkpoint recovery mode', async () => {
    const { env, repoBoard } = createEnv();
    const response = await handleRetryRun(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/retry', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );
    expect(response.status).toBe(200);

    expect(repoBoard.retryRun).toHaveBeenCalledWith('run_repo_1_demo', {
      tenantId: 'tenant_local',
      recoveryMode: 'latest_checkpoint'
    });
  });

  it('forwards explicit checkpoint recovery options', async () => {
    const { env, repoBoard } = createEnv();
    const response = await handleRetryRun(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/retry', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          recoveryMode: 'latest_checkpoint',
          checkpointId: 'run_repo_1_demo:cp:003:tests'
        })
      }),
      env,
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );
    expect(response.status).toBe(200);

    expect(repoBoard.retryRun).toHaveBeenCalledWith('run_repo_1_demo', {
      tenantId: 'tenant_local',
      recoveryMode: 'latest_checkpoint',
      checkpointId: 'run_repo_1_demo:cp:003:tests'
    });
  });
});
