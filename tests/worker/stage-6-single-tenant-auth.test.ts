import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';

type ApiResult<T> = {
  status: number;
  body: T;
  headers: Headers;
};

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as ExecutionContext;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function resetTenantDb() {
  const db = env.TENANT_DB;
  const now = new Date().toISOString();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS app_tenant_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      external_id TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      domain TEXT,
      created_by_user_id TEXT,
      seat_limit INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL,
      accepted_by_user_id TEXT,
      accepted_at TEXT,
      revoked_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS user_api_tokens (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes_json TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS security_audit_log (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      tenant_id TEXT,
      metadata_json TEXT
    )`
  ).run();
  await db.prepare('DELETE FROM user_sessions').run();
  await db.prepare('DELETE FROM invites').run();
  await db.prepare('DELETE FROM user_api_tokens').run();
  await db.prepare('DELETE FROM security_audit_log').run();
  await db.prepare('DELETE FROM users').run();
  await db.prepare('DELETE FROM app_tenant_config').run();
  await db.prepare(
    `INSERT INTO app_tenant_config
      (id, external_id, slug, name, status, domain, created_by_user_id, seat_limit, created_at, updated_at)
     VALUES (1, ?, ?, ?, 'active', NULL, 'system', 100, ?, ?)`
  ).bind('tenant_local', 'local', 'Local Tenant', now, now).run();
}

async function api<T>(
  path: string,
  init?: RequestInit & {
    sessionToken?: string;
    apiToken?: string;
    bearerToken?: string;
  }
): Promise<ApiResult<T>> {
  const request = new Request(`https://minions.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.sessionToken ? { 'x-session-token': init.sessionToken } : {}),
      ...(init?.apiToken ? { 'x-api-token': init.apiToken } : {}),
      ...(init?.bearerToken ? { Authorization: `Bearer ${init.bearerToken}` } : {}),
      ...(init?.headers ?? {})
    }
  });
  const response = await worker.fetch(request, env, createExecutionContext());
  return {
    status: response.status,
    body: await response.json() as T,
    headers: response.headers
  };
}

describe('Stage 6 single-tenant auth flows', () => {
  beforeEach(async () => {
    await resetTenantDb();
  });

  it('supports signup/login/logout session auth', async () => {
    const email = `${uniqueId('owner')}@example.com`;
    const signup = await api<{
      user: { id: string; email: string };
      token: string;
      activeTenantId: string;
      memberships: Array<{ role: 'owner' | 'member'; seatState: 'active' | 'invited' | 'revoked' }>;
    }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'secret-pass',
        tenantName: 'Local Tenant'
      })
    });

    expect(signup.status).toBe(201);
    expect(signup.body.user.email).toBe(email);
    expect(signup.body.activeTenantId).toBe('tenant_local');
    expect(signup.body.memberships[0]).toMatchObject({ role: 'owner', seatState: 'active' });
    expect(signup.headers.get('set-cookie')).toContain('minions_session=');

    const logout = await api<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
      sessionToken: signup.body.token
    });
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);

    const login = await api<{
      user: { id: string; email: string };
      token: string;
      activeTenantId: string;
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'secret-pass'
      })
    });

    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);
    expect(login.body.activeTenantId).toBe('tenant_local');

    const me = await api<{ user: { id: string }; activeTenantId: string }>('/api/me', {
      sessionToken: login.body.token
    });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(login.body.user.id);
    expect(me.body.activeTenantId).toBe('tenant_local');
  });

  it('supports owner invite creation and invite acceptance account bootstrap', async () => {
    const owner = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueId('owner-invite')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Local Tenant'
      })
    });
    expect(owner.status).toBe(201);

    const invitedEmail = `${uniqueId('invited')}@example.com`;
    const invite = await api<{
      invite: { id: string; email: string; status: 'pending' | 'accepted' };
      token: string;
    }>('/api/invites', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({ email: invitedEmail, role: 'member' })
    });

    expect(invite.status).toBe(201);
    expect(invite.body.invite.email).toBe(invitedEmail);
    expect(invite.body.invite.status).toBe('pending');

    const accept = await api<{
      user: { id: string; email: string; displayName?: string };
      token: string;
      memberships: Array<{ role: 'owner' | 'member'; seatState: 'active' | 'invited' | 'revoked' }>;
      invite: { status: 'accepted' };
    }>(`/api/invites/${encodeURIComponent(invite.body.invite.id)}/accept`, {
      method: 'POST',
      body: JSON.stringify({
        token: invite.body.token,
        password: 'member-pass',
        displayName: 'Invited User'
      })
    });

    expect(accept.status).toBe(201);
    expect(accept.body.user.email).toBe(invitedEmail);
    expect(accept.body.memberships[0]).toMatchObject({ role: 'member', seatState: 'active' });
    expect(accept.body.invite.status).toBe('accepted');

    const memberLogin = await api<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: invitedEmail,
        password: 'member-pass'
      })
    });
    expect(memberLogin.status).toBe(200);

    const memberCannotInvite = await api<{ code: string }>('/api/invites', {
      method: 'POST',
      sessionToken: memberLogin.body.token,
      body: JSON.stringify({ email: `${uniqueId('other')}@example.com` })
    });
    expect(memberCannotInvite.status).toBe(403);
    expect(memberCannotInvite.body.code).toBe('FORBIDDEN');
  });

  it('supports PAT auth via x-api-token and bearer token', async () => {
    const owner = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueId('owner-pat')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Local Tenant'
      })
    });
    expect(owner.status).toBe(201);

    const createdRepo = await api<{ repoId: string }>('/api/repos', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({
        slug: uniqueId('repo'),
        baselineUrl: 'https://repo.example.test',
        defaultBranch: 'main'
      })
    });
    expect(createdRepo.status).toBe(201);

    const pat = await api<{
      token: string;
      tokenRecord: { id: string; name: string; scopes: string[] };
    }>('/api/me/api-tokens', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({
        name: 'Automation Token',
        scopes: ['repos:read', 'board:read']
      })
    });

    expect(pat.status).toBe(201);
    expect(pat.body.token).toBeTruthy();
    expect(pat.body.tokenRecord.name).toBe('Automation Token');

    const withApiHeader = await api<Array<{ repoId: string }>>('/api/repos', {
      apiToken: pat.body.token
    });
    expect(withApiHeader.status).toBe(200);
    expect(withApiHeader.body.some((repo) => repo.repoId === createdRepo.body.repoId)).toBe(true);

    const withBearer = await api<{ repos: Array<{ repoId: string }> }>('/api/board?repoId=all', {
      bearerToken: pat.body.token
    });
    expect(withBearer.status).toBe(200);
    expect(withBearer.body.repos.some((repo) => repo.repoId === createdRepo.body.repoId)).toBe(true);

    const listedBeforeRevoke = await api<Array<{ id: string }>>('/api/me/api-tokens', {
      sessionToken: owner.body.token
    });
    expect(listedBeforeRevoke.status).toBe(200);
    expect(listedBeforeRevoke.body).toHaveLength(1);

    const revoked = await api<{ ok: true }>(`/api/me/api-tokens/${encodeURIComponent(pat.body.tokenRecord.id)}`, {
      method: 'DELETE',
      sessionToken: owner.body.token
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.ok).toBe(true);

    const withRevokedPat = await api<{ code: string }>('/api/repos', {
      apiToken: pat.body.token
    });
    expect(withRevokedPat.status).toBe(401);
    expect(withRevokedPat.body.code).toBe('UNAUTHORIZED');
  });
});
