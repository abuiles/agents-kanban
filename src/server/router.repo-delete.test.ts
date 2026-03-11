import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  resolveSessionByToken: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);

import { handleDeleteRepo } from './router';

function createEnv(options: { repoTenantId?: string } = {}) {
  const boardStub = {
    getRepo: vi.fn(async () => ({
      repoId: 'repo_1',
      tenantId: options.repoTenantId ?? 'tenant_local',
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'acme/demo',
      defaultBranch: 'main',
      baselineUrl: 'https://example.com',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })),
    deleteRepo: vi.fn(async (repoId: string) => ({ repoId, deleted: true }))
  };

  return {
    env: {
      BOARD_INDEX: { getByName: vi.fn(() => boardStub) }
    } as unknown as Env,
    boardStub
  };
}

describe('handleDeleteRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
  });

  it('deletes a repo when tenant access matches', async () => {
    const { env, boardStub } = createEnv();
    const response = await handleDeleteRepo(
      new Request('https://minions.example.test/api/repos/repo_1', {
        method: 'DELETE',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { repoId: 'repo_1' }
    );
    const body = await response.json() as { repoId: string; deleted: boolean };

    expect(response.status).toBe(200);
    expect(body).toEqual({ repoId: 'repo_1', deleted: true });
    expect(boardStub.deleteRepo).toHaveBeenCalledWith('repo_1', 'tenant_local');
  });

  it('rejects cross-tenant repo deletion', async () => {
    const { env, boardStub } = createEnv({ repoTenantId: 'tenant_other' });
    const response = await handleDeleteRepo(
      new Request('https://minions.example.test/api/repos/repo_1', {
        method: 'DELETE',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { repoId: 'repo_1' }
    );

    expect(response.status).toBe(403);
    expect(boardStub.deleteRepo).not.toHaveBeenCalled();
  });
});

