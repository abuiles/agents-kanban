import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  resolveSessionByToken: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  getTenantMembership: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn()
}));

const orchestratorMocks = vi.hoisted(() => ({
  scheduleRunJob: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);
vi.mock('./run-orchestrator', () => orchestratorMocks);

import { handleRerunReview, handleRequestChanges } from './router';
import type { ReviewFinding } from '../ui/domain/types';

const reviewFindings: ReviewFinding[] = [
  {
    findingId: 'rf_1',
    severity: 'high',
    title: 'Database input validation',
    description: 'Validate external payload keys before insert.',
    filePath: 'src/db.ts',
    lineStart: 42,
    status: 'open'
  },
  {
    findingId: 'rf_2',
    severity: 'low',
    title: 'Whitespace formatting',
    description: 'Formatting rules are inconsistent.',
    filePath: 'src/utils.ts',
    lineStart: 8,
    status: 'addressed'
  }
];

class KvStore {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

function createEnv(
  runOverrides: Record<string, unknown> = {},
  options: {
    repoOverrides?: Record<string, unknown>;
    kv?: KvStore;
  } = {}
): Env {
  let run = {
    runId: 'run_repo_1_demo',
    repoId: 'repo_1',
    taskId: 'task_1',
    reviewUrl: 'https://github.com/acme/demo/pull/7',
    reviewNumber: 7,
    reviewFindings,
    reviewExecution: {
      enabled: true,
      trigger: 'auto_on_review',
      promptSource: 'native',
      status: 'completed',
      round: 1
    },
    ...runOverrides
  };

  const repoBoard = {
    getRun: vi.fn(async () => run),
    transitionRun: vi.fn(async (_runId: string, patch: Record<string, unknown>) => {
      run = { ...run, ...patch };
      return run;
    }),
    requestRunChanges: vi.fn(async (_runId: string, request: { prompt: string; selection?: Record<string, unknown> }) => {
      (run as Record<string, unknown>).changeRequest = {
        prompt: request.prompt,
        requestedAt: '2026-03-02T01:00:00.000Z',
        ...(request.selection ? { selection: request.selection } : {})
      };
      return run;
    }),
    getTask: vi.fn(async () => ({
      task: {
        taskId: 'task_1',
        repoId: 'repo_1',
        title: 'Auto-review task',
        taskPrompt: 'Keep this task focused.',
        acceptanceCriteria: ['No regression.'],
        context: { links: [] },
        status: 'ACTIVE',
        tenantId: 'tenant_local',
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z'
      }
    }))
  };

  const board = {
    findRunRepoId: vi.fn(async () => 'repo_1'),
    getRepo: vi.fn(async () => ({
      repoId: 'repo_1',
      tenantId: 'tenant_local',
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com',
      projectPath: 'acme/demo',
      ...options.repoOverrides
    })),
    getScmCredentialSecret: vi.fn(async () => 'SCM_TOKEN')
  };

  return {
    SECRETS_KV: (options.kv ?? new KvStore()) as unknown as KVNamespace,
    BOARD_INDEX: {
      getByName: vi.fn(() => board)
    },
    REPO_BOARD: {
      getByName: vi.fn(() => repoBoard)
    }
  } as unknown as Env;
}

describe('handleRequestChanges', () => {
  const markerA = '<!-- agentboard-review:finding:rf_1:run_repo_1_demo -->';

  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    orchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'wf_review_request_1' });
  });

  it('selects findings and includes reply context for selective request-changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/api/2/issue/ABC-123/comment')) {
        return new Response(JSON.stringify({
          comments: [
            { body: `${markerA} Reviewer requested stronger null checks.` },
            { body: `${markerA} Please include request payload schema validation too.` }
          ]
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const response = await handleRequestChanges(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/request-changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': 'session-token' },
        body: JSON.stringify({
          prompt: 'Please focus on these findings only.',
          reviewSelection: {
            mode: 'include',
            findingIds: ['rf_1', 'rf_unknown'],
            includeReplies: true
          }
        })
      }),
      createEnv({
        reviewProvider: 'jira',
        reviewUrl: 'https://jira.example.com/browse/ABC-123',
        reviewFindings
      } as Record<string, unknown>),
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );

    const body = await response.json() as { changeRequest?: { prompt?: string; selection?: Record<string, unknown> } };
    expect(response.status).toBe(200);
    expect(orchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'full_run', runId: 'run_repo_1_demo' })
    );
    expect(body.changeRequest).toMatchObject({ prompt: expect.any(String) });
    expect((body.changeRequest?.selection as Record<string, unknown> | undefined)?.selectedFindingIds).toEqual(['rf_1']);
    expect(body.changeRequest?.prompt).toContain('Review change request context:');
    expect(body.changeRequest?.prompt).toContain('Mode: include');
    expect(body.changeRequest?.prompt).toContain('Selected findings: rf_1');
    expect(body.changeRequest?.prompt).toContain('Requested findings: rf_1, rf_unknown');
    expect(body.changeRequest?.prompt).toContain('Unknown findings: rf_unknown');
    expect(body.changeRequest?.prompt).toContain('Provider replies for rf_1:');
  });

  it('merges persisted webhook hints with on-demand github replies for selective request-changes', async () => {
    const markerA = '<!-- agentboard-review:finding:rf_1:run_repo_1_demo -->';
    const kv = new KvStore();
    kv.values.set(
      'github/reply-context:tenant_local:acme%2Fdemo:7:rf_1',
      JSON.stringify({
        findingId: 'rf_1',
        projectPath: 'acme/demo',
        reviewNumber: 7,
        updatedAt: '2026-03-03T10:00:00.000Z',
        hints: [
          {
            findingId: 'rf_1',
            runId: 'run_repo_1_demo',
            body: `${markerA} Persisted advice B`,
            providerEventId: 'pull_request_review_comment:501',
            deliveryId: 'delivery-501',
            recordedAt: '2026-03-03T10:00:00.000Z'
          },
          {
            findingId: 'rf_1',
            runId: 'run_repo_1_demo',
            body: `${markerA} Persisted advice A`,
            providerEventId: 'pull_request_review_comment:502',
            deliveryId: 'delivery-502',
            recordedAt: '2026-03-03T10:01:00.000Z'
          }
        ]
      })
    );

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/repos/acme/demo/pulls/7/comments')) {
        return new Response(JSON.stringify([
          {
            id: 100,
            body: `${markerA} Root comment`
          },
          {
            id: 101,
            in_reply_to_id: 100,
            body: `${markerA} Persisted advice B`
          },
          {
            id: 102,
            in_reply_to_id: 100,
            body: `${markerA} On-demand advice C`
          }
        ]), { status: 200 });
      }
      if (url.includes('/repos/acme/demo/issues/7/comments')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const response = await handleRequestChanges(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/request-changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': 'session-token' },
        body: JSON.stringify({
          prompt: 'Use merged provider context.',
          reviewSelection: {
            mode: 'include',
            findingIds: ['rf_1'],
            includeReplies: true
          }
        })
      }),
      createEnv({
        reviewProvider: 'github',
        reviewUrl: 'https://github.com/acme/demo/pull/7',
        reviewNumber: 7,
        reviewFindings
      } as Record<string, unknown>, { kv }),
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );

    const body = await response.json() as { changeRequest?: { prompt?: string; selection?: Record<string, unknown> } };

    expect(response.status).toBe(200);
    expect((body.changeRequest?.selection as Record<string, unknown> | undefined)?.selectedFindingIds).toEqual(['rf_1']);
    expect(body.changeRequest?.prompt).toContain('Provider replies for rf_1:');
    expect(body.changeRequest?.prompt).toContain('- <!-- agentboard-review:finding:rf_1:run_repo_1_demo --> On-demand advice C');
    expect(body.changeRequest?.prompt).toContain('- <!-- agentboard-review:finding:rf_1:run_repo_1_demo --> Persisted advice A');
    expect(body.changeRequest?.prompt).toContain('- <!-- agentboard-review:finding:rf_1:run_repo_1_demo --> Persisted advice B');
    expect(body.changeRequest?.prompt).not.toContain('Persisted advice B\n- <!-- agentboard-review:finding:rf_1:run_repo_1_demo --> Persisted advice B');
  });
});

describe('handleRerunReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
    orchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'wf_review_1' });
  });

  it('queues manual review rerun using review_only mode', async () => {
    const response = await handleRerunReview(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/review', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      createEnv(),
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );

    const body = await response.json() as { runId: string; workflowInstanceId?: string };

    expect(response.status).toBe(200);
    expect(orchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', runId: 'run_repo_1_demo' })
    );
    expect(body.runId).toBe('run_repo_1_demo');
    expect(body.workflowInstanceId).toBe('wf_review_1');
  });

  it('is idempotent-safe when review execution is already running', async () => {
    const env = createEnv({
      reviewExecution: {
        enabled: true,
        trigger: 'manual_rerun',
        promptSource: 'native',
        status: 'running',
        round: 2
      }
    });

    const response = await handleRerunReview(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/review', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' },
      {} as ExecutionContext<unknown>
    );

    const body = await response.json() as { reviewExecution?: { status?: string; round?: number } };

    expect(response.status).toBe(200);
    expect(orchestratorMocks.scheduleRunJob).not.toHaveBeenCalled();
    expect(body.reviewExecution).toMatchObject({ status: 'running', round: 2 });
  });
});
