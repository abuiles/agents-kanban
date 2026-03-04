import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  resolveSessionByToken: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  listSentinelRuns: vi.fn(),
  listSentinelEvents: vi.fn(),
  createSentinelRun: vi.fn(),
  updateSentinelRun: vi.fn(),
  claimSentinelRunTask: vi.fn(),
  appendSentinelEvent: vi.fn(),
  upsertRepoSentinelConfig: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);

import {
  handleGetRepoSentinel,
  handleListRepoSentinelEvents,
  handlePatchRepoSentinelConfig,
  handlePauseRepoSentinel,
  handleResumeRepoSentinel,
  handleStartRepoSentinel,
  handleStopRepoSentinel
} from './router';

function createEnv(overrides?: {
  repoTenantId?: string;
  sentinelConfig?: Record<string, unknown>;
}) {
  const boardStub = {
    getRepo: vi.fn(async () => ({
      repoId: 'repo_1',
      tenantId: overrides?.repoTenantId ?? 'tenant_local',
      sentinelConfig: {
        enabled: true,
        globalMode: true,
        reviewGate: { requireChecksGreen: true, requireAutoReviewPass: true },
        mergePolicy: { autoMergeEnabled: false, method: 'squash', deleteBranch: true },
        conflictPolicy: { rebaseBeforeMerge: true, remediationEnabled: true, maxAttempts: 2 },
        ...(overrides?.sentinelConfig ?? {})
      }
    })),
    updateRepo: vi.fn(async (_repoId: string, patch: Record<string, unknown>) => ({
      repoId: 'repo_1',
      tenantId: 'tenant_local',
      sentinelConfig: patch.sentinelConfig
    }))
  };
  const repoBoardStub = {
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async () => ({
      task: {
        taskId: 'task_active',
        repoId: 'repo_1',
        tenantId: overrides?.repoTenantId ?? 'tenant_local',
        title: 'Active task',
        taskPrompt: 'Prompt',
        acceptanceCriteria: [],
        context: { links: [] },
        status: 'DONE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      repo: {
        repoId: 'repo_1',
        tenantId: overrides?.repoTenantId ?? 'tenant_local',
        name: 'Test Repo',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sentinelConfig: { globalMode: true }
      },
      runs: [],
      latestRun: undefined
    })),
    startRun: vi.fn(async () => ({
      runId: 'run_1',
      taskId: 'task_1',
      repoId: 'repo_1',
      status: 'RUNNING',
      branchName: 'task-1'
    })),
    transitionRun: vi.fn(async () => ({
      runId: 'run_1',
      taskId: 'task_1',
      repoId: 'repo_1',
      status: 'RUNNING',
      branchName: 'task-1'
    }))
  };

  return {
    BOARD_INDEX: {
      getByName: vi.fn(() => boardStub)
    },
    REPO_BOARD: {
      getByName: vi.fn(() => repoBoardStub)
    }
  } as unknown as Env;
}

function authHeaders() {
  return { 'x-session-token': 'sess_token' };
}

describe('repo sentinel router handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    tenantAuthDbMocks.listSentinelEvents.mockResolvedValue([]);
    tenantAuthDbMocks.appendSentinelEvent.mockResolvedValue({});
    tenantAuthDbMocks.claimSentinelRunTask.mockImplementation(async (_env: Env, _tenantId: string, runId: string) => ({
      id: runId,
      tenantId: _tenantId,
      repoId: 'repo_1',
      scopeType: 'global',
      status: 'running',
      attemptCount: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }));
  });

  it('returns repo sentinel status', async () => {
    tenantAuthDbMocks.listSentinelRuns.mockResolvedValue([
      { id: 'sentinel_run_1', repoId: 'repo_1', tenantId: 'tenant_local', scopeType: 'global', status: 'running', attemptCount: 0, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    ]);
    tenantAuthDbMocks.listSentinelEvents.mockResolvedValue([{ id: 'event_1' }]);

    const response = await handleGetRepoSentinel(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel', { headers: authHeaders() }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const body = await response.json() as { repoId: string; run?: { id: string }; events: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.repoId).toBe('repo_1');
    expect(body.run?.id).toBe('sentinel_run_1');
    expect(body.events[0]?.id).toBe('event_1');
  });

  it('updates sentinel config via API and repo model', async () => {
    tenantAuthDbMocks.listSentinelRuns.mockResolvedValue([]);
    tenantAuthDbMocks.upsertRepoSentinelConfig.mockResolvedValue({
      enabled: true,
      globalMode: false,
      defaultGroupTag: 'payments',
      reviewGate: { requireChecksGreen: true, requireAutoReviewPass: true },
      mergePolicy: { autoMergeEnabled: false, method: 'squash', deleteBranch: true },
      conflictPolicy: { rebaseBeforeMerge: true, remediationEnabled: true, maxAttempts: 2 }
    });

    const response = await handlePatchRepoSentinelConfig(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel/config', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ globalMode: false, defaultGroupTag: 'payments' })
      }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const body = await response.json() as { config: { globalMode: boolean; defaultGroupTag?: string } };

    expect(response.status).toBe(200);
    expect(body.config.globalMode).toBe(false);
    expect(body.config.defaultGroupTag).toBe('payments');
    expect(tenantAuthDbMocks.upsertRepoSentinelConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps start idempotent when sentinel is already running', async () => {
    tenantAuthDbMocks.listSentinelRuns.mockResolvedValue([
      { id: 'sentinel_run_1', repoId: 'repo_1', tenantId: 'tenant_local', scopeType: 'global', status: 'running', attemptCount: 0, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    ]);

    const response = await handleStartRepoSentinel(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel/start', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({})
      }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const body = await response.json() as { changed: boolean; run?: { id: string } };

    expect(response.status).toBe(200);
    expect(body.changed).toBe(false);
    expect(body.run?.id).toBe('sentinel_run_1');
    expect(tenantAuthDbMocks.createSentinelRun).not.toHaveBeenCalled();
  });

  it('supports pause, resume, and stop transitions', async () => {
    tenantAuthDbMocks.listSentinelRuns.mockResolvedValue([
      { id: 'sentinel_run_1', repoId: 'repo_1', tenantId: 'tenant_local', scopeType: 'global', status: 'running', attemptCount: 0, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    ]);
    tenantAuthDbMocks.updateSentinelRun.mockImplementation(async (_env: Env, _tenantId: string, runId: string, patch: { status?: string }) => ({
      id: runId,
      repoId: 'repo_1',
      tenantId: 'tenant_local',
      scopeType: 'global',
      status: patch.status ?? 'running',
      attemptCount: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }));

    const pauseResponse = await handlePauseRepoSentinel(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel/pause', { method: 'POST', headers: authHeaders() }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const pauseBody = await pauseResponse.json() as { changed: boolean };
    expect(pauseBody.changed).toBe(true);

    tenantAuthDbMocks.listSentinelRuns.mockResolvedValue([
      { id: 'sentinel_run_1', repoId: 'repo_1', tenantId: 'tenant_local', scopeType: 'global', status: 'paused', attemptCount: 0, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    ]);
    const resumeResponse = await handleResumeRepoSentinel(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel/resume', { method: 'POST', headers: authHeaders() }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const resumeBody = await resumeResponse.json() as { changed: boolean };
    expect(resumeBody.changed).toBe(true);

    const stopResponse = await handleStopRepoSentinel(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel/stop', { method: 'POST', headers: authHeaders() }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const stopBody = await stopResponse.json() as { changed: boolean };
    expect(stopBody.changed).toBe(true);
    expect(tenantAuthDbMocks.updateSentinelRun).toHaveBeenCalled();
  });

  it('validates sentinel events limit query', async () => {
    const response = await handleListRepoSentinelEvents(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel/events?limit=0', { headers: authHeaders() }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const body = await response.json() as { code: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('enforces tenant access checks for sentinel endpoints', async () => {
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(false);
    const response = await handleGetRepoSentinel(
      new Request('https://minions.example.test/api/repos/repo_1/sentinel', { headers: authHeaders() }),
      createEnv(),
      { repoId: 'repo_1' }
    );
    const body = await response.json() as { code: string };
    expect(response.status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });
});
