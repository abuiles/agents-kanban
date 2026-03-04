import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  resolveSessionByToken: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  getTenantMembership: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);

import { handleGetRunCheckpoints, handleGetTaskCheckpoints } from './router';

function createEnv() {
  const checkpoints = [{
    checkpointId: 'run_repo_1_demo:cp:001:codex',
    runId: 'run_repo_1_demo',
    repoId: 'repo_1',
    taskId: 'task_repo_1_demo',
    phase: 'codex' as const,
    commitSha: 'a'.repeat(40),
    commitMessage: 'agentskanban checkpoint 001 (codex) [run_repo_1_demo]',
    createdAt: '2026-03-03T12:00:00.000Z'
  }];

  const repoBoard = {
    getRunCheckpoints: vi.fn(async () => checkpoints),
    getTaskCheckpoints: vi.fn(async (_taskId: string, options?: { latest?: boolean }) => options?.latest ? [checkpoints[0]] : checkpoints)
  };

  const board = {
    findRunRepoId: vi.fn(async () => 'repo_1'),
    findTaskRepoId: vi.fn(async () => 'repo_1'),
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

describe('checkpoint read endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
  });

  it('returns run checkpoints for GET /api/runs/:runId/checkpoints', async () => {
    const { env, repoBoard } = createEnv();
    const response = await handleGetRunCheckpoints(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/checkpoints', {
        method: 'GET',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Array<{ checkpointId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.checkpointId).toBe('run_repo_1_demo:cp:001:codex');
    expect(repoBoard.getRunCheckpoints).toHaveBeenCalledWith('run_repo_1_demo', 'tenant_local');
  });

  it('returns latest task checkpoint when latest=true', async () => {
    const { env, repoBoard } = createEnv();
    const response = await handleGetTaskCheckpoints(
      new Request('https://minions.example.test/api/tasks/task_repo_1_demo/checkpoints?latest=true', {
        method: 'GET',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { taskId: 'task_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Array<{ checkpointId: string }>;
    expect(body).toHaveLength(1);
    expect(repoBoard.getTaskCheckpoints).toHaveBeenCalledWith('task_repo_1_demo', { latest: true, tenantId: 'tenant_local' });
  });

  it('returns full task checkpoint list when latest query is omitted', async () => {
    const { env, repoBoard } = createEnv();
    const response = await handleGetTaskCheckpoints(
      new Request('https://minions.example.test/api/tasks/task_repo_1_demo/checkpoints', {
        method: 'GET',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { taskId: 'task_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    expect(repoBoard.getTaskCheckpoints).toHaveBeenCalledWith('task_repo_1_demo', { latest: false, tenantId: 'tenant_local' });
  });
});
