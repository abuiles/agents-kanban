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
};

async function api<T>(path: string, init?: RequestInit & { sessionToken?: string }): Promise<ApiResult<T>> {
  const request = new Request(`https://minions.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.sessionToken ? { 'x-session-token': init.sessionToken } : {}),
      ...(init?.headers ?? {})
    }
  });
  const response = await worker.fetch(request, env, createExecutionContext());
  return {
    status: response.status,
    body: await response.json() as T
  };
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

describe('Stage 4.5 memberships and seats', () => {
  beforeEach(async () => {
    await ensureTenantDbSchema();
  });

  it('implements owner/member roles and create/update member endpoints', async () => {
    const owner = await api<{ token: string; user: { id: string } }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('owner-membership')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Membership Owner Org'
      })
    });
    expect(owner.status).toBe(201);

    const memberUser = await api<{ user: { id: string } }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('member-membership')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Membership Member Org'
      })
    });
    expect(memberUser.status).toBe(201);

    const tenant = await api<{
      tenant: { id: string; slug: string; seatLimit: number };
      ownerMembership: { role: 'owner'; seatState: 'active'; userId: string };
    }>('/api/tenants', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({
        name: 'Membership Org',
        slug: uniqueSlug('membership-org'),
        seatLimit: 3
      })
    });

    expect(tenant.status).toBe(201);
    expect(tenant.body.ownerMembership).toMatchObject({
      userId: owner.body.user.id,
      role: 'owner',
      seatState: 'active'
    });

    const createdMember = await api<{
      member: { id: string; userId: string; role: 'member'; seatState: 'active' | 'invited' | 'revoked' };
    }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}/members`, {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({ userId: memberUser.body.user.id, role: 'member', seatState: 'invited' })
    });

    expect(createdMember.status).toBe(201);
    expect(createdMember.body.member).toMatchObject({
      userId: memberUser.body.user.id,
      role: 'member',
      seatState: 'invited'
    });

    const updatedMember = await api<{
      member: { id: string; role: 'member'; seatState: 'active' | 'invited' | 'revoked' };
    }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}/members/${encodeURIComponent(createdMember.body.member.id)}`, {
      method: 'PATCH',
      sessionToken: owner.body.token,
      body: JSON.stringify({ seatState: 'active' })
    });

    expect(updatedMember.status).toBe(200);
    expect(updatedMember.body.member).toMatchObject({
      role: 'member',
      seatState: 'active'
    });
  });

  it('enforces seat states on access checks and owner-only member management', async () => {
    const owner = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('owner-seats')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Seat Owner Org'
      })
    });
    expect(owner.status).toBe(201);

    const memberUser = await api<{ token: string; user: { id: string } }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('member-seats')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Seat Member Org'
      })
    });
    expect(memberUser.status).toBe(201);

    const tenant = await api<{ tenant: { id: string } }>('/api/tenants', {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({
        name: 'Seat Org',
        slug: uniqueSlug('seat-org'),
        seatLimit: 2
      })
    });

    expect(tenant.status).toBe(201);

    const member = await api<{ member: { id: string } }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}/members`, {
      method: 'POST',
      sessionToken: owner.body.token,
      body: JSON.stringify({ userId: memberUser.body.user.id, role: 'member', seatState: 'invited' })
    });
    expect(member.status).toBe(201);

    const invitedAccess = await api<{
      code: string;
      message: string;
    }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}`, {
      sessionToken: memberUser.body.token
    });
    expect(invitedAccess.status).toBe(403);
    expect(invitedAccess.body.code).toBe('FORBIDDEN');

    const nonOwnerMutation = await api<{ code: string }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}/members`, {
      method: 'POST',
      sessionToken: memberUser.body.token,
      body: JSON.stringify({ userId: 'user_extra', role: 'member', seatState: 'invited' })
    });
    expect(nonOwnerMutation.status).toBe(403);

    const activatedMember = await api<{ member: { seatState: 'active' } }>(
      `/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}/members/${encodeURIComponent(member.body.member.id)}`,
      {
        method: 'PATCH',
        sessionToken: owner.body.token,
        body: JSON.stringify({ seatState: 'active' })
      }
    );
    expect(activatedMember.status).toBe(200);
    expect(activatedMember.body.member.seatState).toBe('active');

    const activeAccess = await api<{ id: string }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}`, {
      sessionToken: memberUser.body.token
    });
    expect(activeAccess.status).toBe(200);
    expect(activeAccess.body.id).toBe(tenant.body.tenant.id);

    const revokedMember = await api<{ member: { seatState: 'revoked' } }>(
      `/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}/members/${encodeURIComponent(member.body.member.id)}`,
      {
        method: 'PATCH',
        sessionToken: owner.body.token,
        body: JSON.stringify({ seatState: 'revoked' })
      }
    );
    expect(revokedMember.status).toBe(200);
    expect(revokedMember.body.member.seatState).toBe('revoked');

    const revokedAccess = await api<{ code: string }>(`/api/tenants/${encodeURIComponent(tenant.body.tenant.id)}`, {
      sessionToken: memberUser.body.token
    });
    expect(revokedAccess.status).toBe(403);
    expect(revokedAccess.body.code).toBe('FORBIDDEN');
  });
});
