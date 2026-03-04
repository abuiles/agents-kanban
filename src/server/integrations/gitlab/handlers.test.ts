import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tenant-auth-db', () => ({
  getPrimaryTenantId: vi.fn(async () => 'tenant_local')
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

function buildEnv(kv: KvStore): Env {
  return {
    SECRETS_KV: kv as unknown as KVNamespace,
    BOARD_INDEX: {
      getByName: () => ({
        listRepos: async () => []
      })
    },
    REPO_BOARD: {
      getByName: () => ({
        getBoardSlice: async () => ({ runs: [] })
      })
    },
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

describe('gitlab webhook handler', () => {
  it('dedupes repeated webhook deliveries by delivery id', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const env = buildEnv(kv);
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
    expect(await first.json()).toMatchObject({ status: 'ignored_repo_unmapped' });
    expect(await second.json()).toMatchObject({ status: 'duplicate_delivery' });
  });

  it('rejects invalid webhook secret', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');
    const env = buildEnv(kv);

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
});
