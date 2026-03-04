import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tenant-auth-db', () => ({
  getPrimaryTenantId: vi.fn(async () => 'tenant_local')
}));
vi.mock('../slack/client', () => ({
  listSlackThreadBindingsForTask: vi.fn(async () => []),
  postSlackThreadMessage: vi.fn()
}));

import { handleGitlabWebhook } from './handlers';

class KvStore {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

function createRepoBoardStub(runs: Array<Record<string, unknown>>) {
  return {
    getBoardSlice: vi.fn(async () => ({ runs })),
    transitionRun: vi.fn()
  };
}

function buildEnv(kv: KvStore, boardRuns: Array<Record<string, unknown>>) {
  return {
    SECRETS_KV: kv as unknown as KVNamespace,
    BOARD_INDEX: {
      getByName: () => ({
        listRepos: async () => [
          {
            repoId: 'repo_1',
            tenantId: 'tenant_local',
            slug: 'group/project',
            scmProvider: 'gitlab',
            scmBaseUrl: 'https://gitlab.example',
            projectPath: 'group/project'
          }
        ]
      })
    },
    REPO_BOARD: {
      getByName: () => createRepoBoardStub(boardRuns)
    }
  } as unknown as Env;
}

function gitlabReviewPendingPayload() {
  return JSON.stringify({
    object_kind: 'merge_request',
    project: { path_with_namespace: 'group/project' },
    object_attributes: {
      iid: 42,
      action: 'open',
      state: 'opened',
      url: 'https://gitlab.example/group/project/-/merge_requests/42'
    }
  });
}

function gitlabReviewFeedbackPayload() {
  return JSON.stringify({
    object_kind: 'note',
    project: { path_with_namespace: 'group/project' },
    merge_request: { iid: 42, web_url: 'https://gitlab.example/group/project/-/merge_requests/42' },
    user: { username: 'reviewer' },
    object_attributes: {
      id: 900,
      note: 'Please add tests.',
      noteable_type: 'MergeRequest',
      system: false
    }
  });
}

function mappedRun() {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    repoId: 'repo_1',
    tenantId: 'tenant_local',
    reviewNumber: 42,
    status: 'PR_OPEN',
    timeline: [],
    startedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('gitlab webhook handler', () => {
  it('transitions run loop state to REVIEW_PENDING on review pending webhooks', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const board = createRepoBoardStub([mappedRun()]);
    const env = {
      ...buildEnv(kv, [mappedRun()]),
      REPO_BOARD: { getByName: () => board }
    } as unknown as Env;

    const response = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'shared-token',
        'x-gitlab-event-uuid': 'evt-456'
      },
      body: gitlabReviewPendingPayload()
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'mirrored_review_pending', runId: 'run_1' });
    expect(board.transitionRun).toHaveBeenCalledWith('run_1', { loopState: 'REVIEW_PENDING' });
  });

  it('transitions run loop state to DECISION_REQUIRED on review feedback webhooks', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const board = createRepoBoardStub([mappedRun()]);
    const env = {
      ...buildEnv(kv, [mappedRun()]),
      REPO_BOARD: { getByName: () => board }
    } as unknown as Env;

    const response = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'shared-token',
        'x-gitlab-event-uuid': 'evt-457'
      },
      body: gitlabReviewFeedbackPayload()
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'mirrored_feedback', runId: 'run_1' });
    expect(board.transitionRun).toHaveBeenCalledWith('run_1', { loopState: 'DECISION_REQUIRED' });
  });

  it('dedupes repeated webhook deliveries by delivery id', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const env = {
      ...buildEnv(kv, []),
      REPO_BOARD: { getByName: () => createRepoBoardStub([]) }
    } as unknown as Env;
    const body = gitlabReviewPendingPayload();

    const first = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'shared-token',
        'x-gitlab-event-uuid': 'evt-123'
      },
      body
    }), env);
    const second = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'shared-token',
        'x-gitlab-event-uuid': 'evt-123'
      },
      body
    }), env);

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'ignored_run_unmapped' });
    expect(await second.json()).toMatchObject({ status: 'duplicate_delivery' });
  });

  it('rejects invalid webhook secret', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const env = {
      ...buildEnv(kv, []),
      REPO_BOARD: { getByName: () => createRepoBoardStub([]) }
    } as unknown as Env;

    const response = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'bad-token'
      },
      body: gitlabReviewPendingPayload()
    }), env);

    expect(response.status).toBe(401);
  });

  it('returns BAD_REQUEST for malformed webhook json', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const env = {
      ...buildEnv(kv, []),
      REPO_BOARD: { getByName: () => createRepoBoardStub([]) }
    } as unknown as Env;

    const response = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'shared-token'
      },
      body: '{"object_kind":'
    }), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid GitLab webhook payload.'
    });
  });
});
