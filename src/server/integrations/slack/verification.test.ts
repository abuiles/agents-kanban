import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSlackSignature, verifySlackRequest } from './verification';

type KvPutOptions = {
  expirationTtl?: number;
};

function createKv(values: Map<string, string> = new Map()) {
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string, _options?: KvPutOptions) {
      values.set(key, value);
    },
    values
  };
}

describe('slack verification', () => {
  let kv: ReturnType<typeof createKv>;

  beforeEach(() => {
    kv = createKv();
  });

  it('accepts valid signatures and returns tenant context', async () => {
    kv.values.set('slack/signing-secret', 'shared-secret');
    const rawBody = 'token=abc&text=fix+ABC-42';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('shared-secret', timestamp, rawBody);

    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
        'x-slack-team-id': 'team_one'
      },
      body: rawBody
    });
    const result = await verifySlackRequest({ SECRETS_KV: kv as unknown as KVNamespace } as unknown as Env, request, rawBody);
    expect(result.teamId).toBe('team_one');
    expect(result.timestamp).toBe(timestamp);
    expect(kv.values.size).toBeGreaterThan(1);
  });

  it('rejects invalid signatures', async () => {
    kv.values.set('slack/signing-secret', 'shared-secret');
    const rawBody = 'text=fix+ABC-42';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': 'v0=bad',
        'x-slack-team-id': 'team_one'
      },
      body: rawBody
    });

    await expect(
      verifySlackRequest({ SECRETS_KV: kv as unknown as KVNamespace } as unknown as Env, request, rawBody)
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects replayed requests using the same signature and timestamp', async () => {
    kv.values.set('slack/signing-secret', 'shared-secret');
    const rawBody = 'text=fix+ABC-42';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('shared-secret', timestamp, rawBody);

    const requestA = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
        'x-slack-team-id': 'team_one'
      },
      body: rawBody
    });
    const requestB = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
        'x-slack-team-id': 'team_one'
      },
      body: rawBody
    });

    await expect(
      verifySlackRequest({ SECRETS_KV: kv as unknown as KVNamespace } as unknown as Env, requestA, rawBody)
    ).resolves.toBeDefined();
    await expect(
      verifySlackRequest({ SECRETS_KV: kv as unknown as KVNamespace } as unknown as Env, requestB, rawBody)
    ).rejects.toMatchObject({ status: 401 });
  });
});
