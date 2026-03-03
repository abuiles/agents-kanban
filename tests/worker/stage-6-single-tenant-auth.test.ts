import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { ensureTenantDbSchema } from './helpers';

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as ExecutionContext;
}

type ApiResult<T> = {
  status: number;
  body: T;
  headers: Headers;
};

async function api<T>(
  path: string,
  init?: RequestInit & {
    sessionToken?: string;
    apiToken?: string;
  }
): Promise<ApiResult<T>> {
  const request = new Request(`https://minions.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.sessionToken ? { 'x-session-token': init.sessionToken } : {}),
      ...(init?.apiToken ? { 'x-api-token': init.apiToken } : {}),
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

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

describe('Stage 6 single-tenant auth/invite/PAT flow', () => {
  beforeEach(async () => {
    await ensureTenantDbSchema();
  });

  it('supports login/logout + /api/me session flow', async () => {
    const ownerEmail = uniqueEmail('owner-login');
    const signup = await api<{ user: { email: string }; token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: ownerEmail,
        password: 'secret-pass',
        displayName: 'Owner Login',
        tenantName: 'Local deployment'
      })
    });
    expect(signup.status).toBe(201);
    expect(signup.body.user.email).toBe(ownerEmail);
    expect(signup.body.token).toBeTruthy();
    expect(signup.headers.get('set-cookie')).toContain('minions_session=');

    const logout = await api<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
      sessionToken: signup.body.token
    });
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);

    const login = await api<{ user: { email: string }; token: string; activeTenantId: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: ownerEmail,
        password: 'secret-pass'
      })
    });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(ownerEmail);
    expect(login.body.activeTenantId).toBe('tenant_local');
    expect(login.body.token).toBeTruthy();

    const me = await api<{ user: { email: string }; activeTenantId: string }>('/api/me', {
      sessionToken: login.body.token
    });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ownerEmail);
    expect(me.body.activeTenantId).toBe('tenant_local');
  });

  it('supports owner invite lifecycle and invite acceptance account creation', async () => {
    const owner = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail('owner-invite'),
        password: 'secret-pass',
        displayName: 'Owner Invite',
        tenantName: 'Local deployment'
      })
    });
    expect(owner.status).toBe(201);

    const invitedEmail = uniqueEmail('member-invite');
    const createdInvite = await api<{
      invite: { id: string; email: string; status: 'pending' | 'accepted' };
      token: string;
    }>('/api/invites', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({
        email: invitedEmail,
        role: 'member'
      })
    });
    expect(createdInvite.status).toBe(201);
    expect(createdInvite.body.invite.email).toBe(invitedEmail);
    expect(createdInvite.body.invite.status).toBe('pending');
    expect(createdInvite.body.token).toBeTruthy();

    const listedInvites = await api<Array<{ id: string; email: string; status: string }>>('/api/invites', {
      sessionToken: owner.body.token
    });
    expect(listedInvites.status).toBe(200);
    expect(listedInvites.body.map((invite) => invite.id)).toContain(createdInvite.body.invite.id);

    const accepted = await api<{
      user: { email: string };
      invite: { id: string; status: 'accepted' };
      token: string;
    }>(`/api/invites/${encodeURIComponent(createdInvite.body.invite.id)}/accept`, {
      method: 'POST',
      body: JSON.stringify({
        token: createdInvite.body.token,
        password: 'member-pass',
        displayName: 'Invited Member'
      })
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.email).toBe(invitedEmail);
    expect(accepted.body.invite.id).toBe(createdInvite.body.invite.id);
    expect(accepted.body.invite.status).toBe('accepted');
    expect(accepted.body.token).toBeTruthy();
  });

  it('supports PAT create/list/revoke and auth via header + bearer token', async () => {
    const ownerEmail = uniqueEmail('owner-pat');
    const owner = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: ownerEmail,
        password: 'secret-pass',
        displayName: 'Owner PAT',
        tenantName: 'Local deployment'
      })
    });
    expect(owner.status).toBe(201);

    const createdPat = await api<{
      token: string;
      tokenRecord: { id: string; name: string; scopes: string[] };
    }>('/api/me/api-tokens', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({
        name: 'ci-token',
        scopes: ['board:read', 'runs:write']
      })
    });
    expect(createdPat.status).toBe(201);
    expect(createdPat.body.token).toBeTruthy();
    expect(createdPat.body.tokenRecord.name).toBe('ci-token');

    const listedPat = await api<Array<{ id: string; scopes: string[] }>>('/api/me/api-tokens', {
      sessionToken: owner.body.token
    });
    expect(listedPat.status).toBe(200);
    expect(listedPat.body).toHaveLength(1);
    expect(listedPat.body[0].id).toBe(createdPat.body.tokenRecord.id);

    const meWithApiToken = await api<{ user: { email: string } }>('/api/me', {
      apiToken: createdPat.body.token
    });
    expect(meWithApiToken.status).toBe(200);
    expect(meWithApiToken.body.user.email).toBe(ownerEmail);

    const meWithBearerPat = await api<{ user: { email: string } }>('/api/me', {
      headers: {
        authorization: `Bearer ${createdPat.body.token}`
      }
    });
    expect(meWithBearerPat.status).toBe(200);
    expect(meWithBearerPat.body.user.email).toBe(ownerEmail);

    const revoked = await api<{ ok: boolean }>(`/api/me/api-tokens/${encodeURIComponent(createdPat.body.tokenRecord.id)}`, {
      method: 'DELETE',
      sessionToken: owner.body.token
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.ok).toBe(true);

    const revokedUse = await api<{ code: string }>('/api/me', {
      apiToken: createdPat.body.token
    });
    expect(revokedUse.status).toBe(401);
    expect(revokedUse.body.code).toBe('UNAUTHORIZED');
  });

  it('returns not found for removed platform support routes', async () => {
    const response = await api<{ code: string }>('/api/platform/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'platform@example.com', password: 'secret-pass' })
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
