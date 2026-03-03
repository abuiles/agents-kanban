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
    body: await response.json() as T
  };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

describe('single-tenant personal API tokens', () => {
  beforeEach(async () => {
    await ensureTenantDbSchema();
  });

  it('creates, lists, authenticates with, and revokes personal API tokens', async () => {
    const signup = await api<{ token: string; user: { id: string; email: string } }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail('pat-user'),
        password: 'secret-pass',
        tenantName: 'Local deployment'
      })
    });
    expect(signup.status).toBe(201);

    const created = await api<{
      token: string;
      tokenRecord: { id: string; userId: string; name: string; scopes: string[] };
    }>('/api/me/api-tokens', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        name: 'automation token',
        scopes: ['runs:read', 'runs:write']
      })
    });

    expect(created.status).toBe(201);
    expect(created.body.token).toBeTruthy();
    expect(created.body.tokenRecord).toMatchObject({
      userId: signup.body.user.id,
      name: 'automation token',
      scopes: ['runs:read', 'runs:write']
    });

    const listed = await api<Array<{ id: string; name: string }>>('/api/me/api-tokens', {
      sessionToken: signup.body.token
    });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.body.tokenRecord.id, name: 'automation token' })
      ])
    );

    const meWithApiTokenHeader = await api<{ user: { id: string; email: string } }>('/api/me', {
      apiToken: created.body.token
    });
    expect(meWithApiTokenHeader.status).toBe(200);
    expect(meWithApiTokenHeader.body.user.id).toBe(signup.body.user.id);

    const meWithBearerPat = await api<{ user: { id: string } }>('/api/me', {
      headers: {
        Authorization: `Bearer ${created.body.token}`
      }
    });
    expect(meWithBearerPat.status).toBe(200);
    expect(meWithBearerPat.body.user.id).toBe(signup.body.user.id);

    const revoked = await api<{ ok: true }>(`/api/me/api-tokens/${encodeURIComponent(created.body.tokenRecord.id)}`, {
      method: 'DELETE',
      sessionToken: signup.body.token
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.ok).toBe(true);

    const authAfterRevoke = await api<{ code: string }>('/api/me', {
      apiToken: created.body.token
    });
    expect(authAfterRevoke.status).toBe(401);
    expect(authAfterRevoke.body.code).toBe('UNAUTHORIZED');
  });
});
