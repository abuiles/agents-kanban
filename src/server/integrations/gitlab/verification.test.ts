import { describe, expect, it } from 'vitest';
import { verifyGitlabWebhookSecret } from './verification';

class KvStore {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('gitlab verification', () => {
  it('accepts requests signed with configured webhook token', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');

    const request = new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'x-gitlab-token': 'shared-token'
      },
      body: '{}'
    });

    await expect(verifyGitlabWebhookSecret({ SECRETS_KV: kv as unknown as KVNamespace } as Env, 'tenant_local', request)).resolves.toBeUndefined();
  });

  it('rejects requests with invalid webhook token', async () => {
    const kv = new KvStore();
    kv.values.set('gitlab/webhook-secret', 'shared-token');

    const request = new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'x-gitlab-token': 'wrong-token'
      },
      body: '{}'
    });

    await expect(verifyGitlabWebhookSecret({ SECRETS_KV: kv as unknown as KVNamespace } as Env, 'tenant_local', request)).rejects.toThrow(/Invalid GitLab webhook token/);
  });
});
