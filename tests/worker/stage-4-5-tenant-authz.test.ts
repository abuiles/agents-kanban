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

async function api<T>(path: string, init?: RequestInit & { sessionToken?: string; apiToken?: string }): Promise<ApiResult<T>> {
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

describe('single-tenant auth and invite flows', () => {
  beforeEach(async () => {
    await ensureTenantDbSchema();
  });

  it('supports signup, logout, and login against the single tenant', async () => {
    const signup = await api<{
      user: { id: string; email: string };
      token: string;
      activeTenantId: string;
      memberships: Array<{ role: 'owner' | 'member'; seatState: 'active' | 'invited' | 'revoked' }>;
    }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail('owner-login'),
        password: 'secret-pass',
        displayName: 'Owner Login',
        tenantName: 'Local deployment'
      })
    });

    expect(signup.status).toBe(201);
    expect(signup.body.activeTenantId).toBe('tenant_local');
    expect(signup.body.memberships).toHaveLength(1);
    expect(signup.body.memberships[0]).toMatchObject({ role: 'owner', seatState: 'active' });
    expect(signup.headers.get('set-cookie')).toContain('minions_session=');

    const me = await api<{ user: { email: string }; activeTenantId: string }>('/api/me', {
      sessionToken: signup.body.token
    });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(signup.body.user.email);
    expect(me.body.activeTenantId).toBe('tenant_local');

    const logout = await api<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
      sessionToken: signup.body.token
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const meAfterLogout = await api<{ code: string }>('/api/me', {
      sessionToken: signup.body.token
    });
    expect(meAfterLogout.status).toBe(401);
    expect(meAfterLogout.body.code).toBe('UNAUTHORIZED');

    const login = await api<{ token: string; activeTenantId: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: signup.body.user.email,
        password: 'secret-pass',
        tenantId: 'tenant_local'
      })
    });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.activeTenantId).toBe('tenant_local');

    const wrongTenantLogin = await api<{ code: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: signup.body.user.email,
        password: 'secret-pass',
        tenantId: 'tenant_other'
      })
    });
    expect(wrongTenantLogin.status).toBe(403);
    expect(wrongTenantLogin.body.code).toBe('FORBIDDEN');
  });

  it('supports owner invite creation/listing and invite acceptance account creation', async () => {
    const ownerSignup = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail('owner-invite'),
        password: 'secret-pass',
        tenantName: 'Local deployment'
      })
    });
    expect(ownerSignup.status).toBe(201);

    const inviteEmail = uniqueEmail('invitee');
    const createdInvite = await api<{
      invite: { id: string; email: string; status: 'pending' | 'accepted' | 'revoked'; role: 'owner' | 'member' };
      token: string;
    }>('/api/invites', {
      method: 'POST',
      sessionToken: ownerSignup.body.token,
      body: JSON.stringify({ email: inviteEmail, role: 'member' })
    });

    expect(createdInvite.status).toBe(201);
    expect(createdInvite.body.invite).toMatchObject({
      email: inviteEmail,
      status: 'pending',
      role: 'member'
    });
    expect(createdInvite.body.token).toBeTruthy();

    const invites = await api<Array<{ id: string; email: string; status: string }>>('/api/invites', {
      sessionToken: ownerSignup.body.token
    });
    expect(invites.status).toBe(200);
    expect(invites.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: createdInvite.body.invite.id, email: inviteEmail, status: 'pending' })
      ])
    );

    const accepted = await api<{
      user: { id: string; email: string; displayName?: string };
      token: string;
      memberships: Array<{ role: 'owner' | 'member'; seatState: 'active' | 'invited' | 'revoked' }>;
      invite: { status: 'accepted'; acceptedByUserId: string };
    }>(`/api/invites/${encodeURIComponent(createdInvite.body.invite.id)}/accept`, {
      method: 'POST',
      body: JSON.stringify({
        token: createdInvite.body.token,
        password: 'member-pass',
        displayName: 'Member One'
      })
    });

    expect(accepted.status).toBe(201);
    expect(accepted.body.user.email).toBe(inviteEmail);
    expect(accepted.body.invite.status).toBe('accepted');
    expect(accepted.body.memberships[0]).toMatchObject({ role: 'member', seatState: 'active' });

    const acceptedUserMe = await api<{ user: { email: string } }>('/api/me', {
      sessionToken: accepted.body.token
    });
    expect(acceptedUserMe.status).toBe(200);
    expect(acceptedUserMe.body.user.email).toBe(inviteEmail);

    const inviteAsMember = await api<{ code: string }>('/api/invites', {
      method: 'POST',
      sessionToken: accepted.body.token,
      body: JSON.stringify({ email: uniqueEmail('forbidden-invite') })
    });
    expect(inviteAsMember.status).toBe(403);
    expect(inviteAsMember.body.code).toBe('FORBIDDEN');
  });
});
