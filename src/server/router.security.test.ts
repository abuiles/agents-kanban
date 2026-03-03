import { describe, expect, it, vi, beforeEach } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  login: vi.fn(),
  resolveSessionByToken: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  getTenantMembership: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);

import { handleAuthLogin, handleListScmCredentials } from './router';

function createEnv(overrides: Partial<Env> = {}): Env {
  const boardStub = {
    listScmCredentials: vi.fn(async () => [{ credentialId: 'gitlab:gitlab.example.com', hasSecret: true }])
  };
  return {
    BOARD_INDEX: {
      getByName: vi.fn(() => boardStub)
    },
    ...overrides
  } as unknown as Env;
}

describe('router security hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not expose session token hash in auth login responses', async () => {
    tenantAuthDbMocks.login.mockResolvedValue({
      user: { id: 'user_1', email: 'owner@example.com' },
      session: {
        id: 'sess_1',
        userId: 'user_1',
        tenantId: 'tenant_local',
        activeTenantId: 'tenant_local',
        tokenHash: 'sensitive-hash',
        expiresAt: '2030-01-01T00:00:00.000Z',
        lastSeenAt: '2030-01-01T00:00:00.000Z'
      },
      token: 'raw-session-token',
      activeTenantId: 'tenant_local',
      memberships: [{ tenantId: 'tenant_local', role: 'owner', seatState: 'active' }]
    });

    const request = new Request('https://minions.example.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret-pass' })
    });

    const response = await handleAuthLogin(request, createEnv());
    const body = await response.json() as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.session.tokenHash).toBeUndefined();
    expect(body.session.id).toBe('sess_1');
    expect(response.headers.get('set-cookie')).toContain('minions_session=');
  });

  it('requires owner role for SCM credential listing', async () => {
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_member' },
      session: { id: 'sess_member', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    tenantAuthDbMocks.getTenantMembership.mockResolvedValue({
      tenantId: 'tenant_local',
      userId: 'user_member',
      role: 'member',
      seatState: 'active'
    });

    const request = new Request('https://minions.example.test/api/scm/credentials', {
      method: 'GET',
      headers: { 'x-session-token': 'member-session-token' }
    });

    const response = await handleListScmCredentials(request, createEnv());
    const body = await response.json() as { code: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });
});
