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
    userId?: string;
    tenantId?: string;
    sessionToken?: string;
  }
): Promise<ApiResult<T>> {
  const request = new Request(`https://minions.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.userId ? { 'x-user-id': init.userId } : {}),
      ...(init?.tenantId ? { 'x-tenant-id': init.tenantId } : {}),
      ...(init?.sessionToken ? { 'x-session-token': init.sessionToken } : {}),
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

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

describe('Stage 4.5 tenant auth context + cross-tenant authorization', () => {
  beforeEach(async () => {
    await ensureTenantDbSchema();
  });

  it('implements signup/login/me and active tenant context resolution from session', async () => {
    const signup = await api<{
      user: { id: string; email: string };
      activeTenantId: string;
      token: string;
      memberships: Array<{ tenantId: string; role: 'owner' | 'member'; seatState: 'active' | 'invited' | 'revoked' }>;
    }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('owner')}@example.com`,
        password: 'secret-pass',
        displayName: 'Owner One',
        tenantName: 'Tenant Auth Org',
        seatLimit: 3
      })
    });

    expect(signup.status).toBe(201);
    expect(signup.body.user.email).toContain('@example.com');
    expect(signup.body.activeTenantId).toMatch(/^tenant_/);
    expect(signup.body.memberships).toHaveLength(1);
    expect(signup.body.memberships[0]).toMatchObject({
      role: 'owner',
      seatState: 'active',
      tenantId: signup.body.activeTenantId
    });
    expect(signup.headers.get('set-cookie')).toContain('minions_session=');

    const me = await api<{
      user: { id: string; email: string };
      activeTenantId: string;
    }>('/api/me', {
      sessionToken: signup.body.token
    });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(signup.body.user.id);
    expect(me.body.activeTenantId).toBe(signup.body.activeTenantId);

    const secondTenant = await api<{ tenant: { id: string } }>('/api/tenants', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        name: 'Second Org',
        slug: uniqueSlug('second-org'),
        seatLimit: 2
      })
    });
    expect(secondTenant.status).toBe(201);

    const switched = await api<{ activeTenantId: string }>('/api/me/tenant-context', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({ tenantId: secondTenant.body.tenant.id })
    });
    expect(switched.status).toBe(200);
    expect(switched.body.activeTenantId).toBe(secondTenant.body.tenant.id);

    const meAfterSwitch = await api<{ activeTenantId: string }>('/api/me', {
      sessionToken: signup.body.token
    });
    expect(meAfterSwitch.status).toBe(200);
    expect(meAfterSwitch.body.activeTenantId).toBe(secondTenant.body.tenant.id);

    const login = await api<{ token: string; activeTenantId: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: signup.body.user.email,
        password: 'secret-pass',
        tenantId: signup.body.activeTenantId
      })
    });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.activeTenantId).toBe(signup.body.activeTenantId);
  });

  it('denies cross-tenant board/task/run access with explicit errors', async () => {
    const signup = await api<{
      token: string;
      activeTenantId: string;
    }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('operator')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Primary Org'
      })
    });
    expect(signup.status).toBe(201);

    const createdRepo = await api<{ repoId: string }>('/api/repos', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        slug: uniqueSlug('tenant-a-repo'),
        baselineUrl: 'https://repo.example.test',
        defaultBranch: 'main'
      })
    });
    expect(createdRepo.status).toBe(201);

    const createdTask = await api<{ taskId: string }>('/api/tasks', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        repoId: createdRepo.body.repoId,
        title: 'Tenant task',
        taskPrompt: 'Do the thing',
        acceptanceCriteria: ['done'],
        context: { links: [] }
      })
    });
    expect(createdTask.status).toBe(201);

    const run = await api<{ runId: string }>('/api/tasks/' + encodeURIComponent(createdTask.body.taskId) + '/run', {
      method: 'POST',
      sessionToken: signup.body.token
    });
    expect(run.status).toBe(200);

    const secondTenant = await api<{ tenant: { id: string } }>('/api/tenants', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        name: 'Secondary Org',
        slug: uniqueSlug('secondary-org')
      })
    });
    expect(secondTenant.status).toBe(201);

    const switched = await api<{ activeTenantId: string }>('/api/me/tenant-context', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({ tenantId: secondTenant.body.tenant.id })
    });
    expect(switched.status).toBe(200);

    const boardDenied = await api<{ code: string; message: string }>(`/api/board?repoId=${encodeURIComponent(createdRepo.body.repoId)}`, {
      sessionToken: signup.body.token
    });
    expect(boardDenied.status).toBe(403);
    expect(boardDenied.body.code).toBe('FORBIDDEN');
    expect(boardDenied.body.message).toContain('Cross-tenant access denied');

    const taskDenied = await api<{ code: string; message: string }>(`/api/tasks/${encodeURIComponent(createdTask.body.taskId)}`, {
      method: 'PATCH',
      sessionToken: signup.body.token,
      body: JSON.stringify({ title: 'forbidden update' })
    });
    expect(taskDenied.status).toBe(403);
    expect(taskDenied.body.code).toBe('FORBIDDEN');
    expect(taskDenied.body.message).toContain('Cross-tenant access denied');

    const runDenied = await api<{ code: string; message: string }>(`/api/runs/${encodeURIComponent(run.body.runId)}`, {
      sessionToken: signup.body.token
    });
    expect(runDenied.status).toBe(403);
    expect(runDenied.body.code).toBe('FORBIDDEN');
    expect(runDenied.body.message).toContain('Cross-tenant access denied');
  });

  it('tenant-filters board/repo/task list projections for active tenant context', async () => {
    const signup = await api<{
      token: string;
      activeTenantId: string;
    }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `${uniqueSlug('viewer')}@example.com`,
        password: 'secret-pass',
        tenantName: 'Tenant List A'
      })
    });
    expect(signup.status).toBe(201);

    const tenantARepo = await api<{ repoId: string }>('/api/repos', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        slug: uniqueSlug('tenant-a-only-repo'),
        baselineUrl: 'https://tenant-a-only.example.test',
        defaultBranch: 'main'
      })
    });
    expect(tenantARepo.status).toBe(201);

    const tenantATask = await api<{ taskId: string }>('/api/tasks', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        repoId: tenantARepo.body.repoId,
        title: 'Tenant A only task',
        taskPrompt: 'Do tenant A thing',
        acceptanceCriteria: ['done'],
        context: { links: [] }
      })
    });
    expect(tenantATask.status).toBe(201);

    const secondTenant = await api<{ tenant: { id: string } }>('/api/tenants', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({
        name: 'Tenant List B',
        slug: uniqueSlug('tenant-list-b')
      })
    });
    expect(secondTenant.status).toBe(201);

    const switched = await api<{ activeTenantId: string }>('/api/me/tenant-context', {
      method: 'POST',
      sessionToken: signup.body.token,
      body: JSON.stringify({ tenantId: secondTenant.body.tenant.id })
    });
    expect(switched.status).toBe(200);
    expect(switched.body.activeTenantId).toBe(secondTenant.body.tenant.id);

    const repos = await api<Array<{ repoId: string }>>('/api/repos', {
      sessionToken: signup.body.token
    });
    expect(repos.status).toBe(200);
    expect(repos.body).toEqual([]);

    const board = await api<{
      repos: Array<{ repoId: string }>;
      tasks: Array<{ taskId: string }>;
      runs: Array<{ runId: string }>;
    }>('/api/board?repoId=all', {
      sessionToken: signup.body.token
    });
    expect(board.status).toBe(200);
    expect(board.body.repos).toEqual([]);
    expect(board.body.tasks).toEqual([]);
    expect(board.body.runs).toEqual([]);

    const tasks = await api<Array<{ taskId: string }>>('/api/tasks?repoId=all', {
      sessionToken: signup.body.token
    });
    expect(tasks.status).toBe(200);
    expect(tasks.body).toEqual([]);
  });
});
