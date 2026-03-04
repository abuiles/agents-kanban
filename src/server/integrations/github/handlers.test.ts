import { describe, expect, it, vi } from 'vitest';
import { buildReviewFindingMarker } from '../../review-posting/adapter';

vi.mock('../../tenant-auth-db', () => ({
  getPrimaryTenantId: vi.fn(async () => 'tenant_local')
}));

import { handleGithubWebhook } from './handlers';

class KvStore {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

async function signBody(secret: string, rawBody: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

async function makeRequest(input: {
  secret: string;
  body: string;
  eventType?: string;
  deliveryId?: string;
  signature?: string;
}) {
  const signature = input.signature ?? await signBody(input.secret, input.body);
  return new Request('https://example.test/api/integrations/github/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': input.eventType ?? 'pull_request_review_comment',
      'x-github-delivery': input.deliveryId ?? 'delivery-1',
      'x-hub-signature-256': signature
    },
    body: input.body
  });
}

function buildEnv(kv: KvStore) {
  return {
    SECRETS_KV: kv as unknown as KVNamespace
  } as Env;
}

describe('github webhook handler', () => {
  it('ingests marker-bearing review replies and persists reply-context hints', async () => {
    const kv = new KvStore();
    kv.values.set('github/webhook-secret', 'shared-secret');
    const marker = buildReviewFindingMarker('rf_1', 'run_1');
    const body = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 17 },
      comment: { id: 901, body: `${marker} Please add a stronger nil check.` }
    });

    const response = await handleGithubWebhook(await makeRequest({
      secret: 'shared-secret',
      body,
      deliveryId: 'delivery-101'
    }), buildEnv(kv));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'accepted',
      hintsPersisted: 1,
      reviewNumber: 17,
      projectPath: 'acme/demo'
    });

    const storedKey = [...kv.values.keys()].find((key) => key.startsWith('github/reply-context:tenant_local'));
    expect(storedKey).toBeDefined();
    const persisted = JSON.parse(kv.values.get(storedKey as string) ?? '{}') as { hints?: Array<{ body?: string; findingId?: string }> };
    expect(persisted.hints?.[0]).toMatchObject({
      findingId: 'rf_1',
      body: `${marker} Please add a stronger nil check.`
    });
  });

  it('dedupes repeated deliveries deterministically', async () => {
    const kv = new KvStore();
    kv.values.set('github/webhook-secret', 'shared-secret');
    const marker = buildReviewFindingMarker('rf_1', 'run_1');
    const body = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 17 },
      comment: { id: 901, body: `${marker} Please add tests.` }
    });
    const env = buildEnv(kv);

    const first = await handleGithubWebhook(await makeRequest({
      secret: 'shared-secret',
      body,
      deliveryId: 'delivery-duplicate'
    }), env);
    const second = await handleGithubWebhook(await makeRequest({
      secret: 'shared-secret',
      body,
      deliveryId: 'delivery-duplicate'
    }), env);

    expect(await first.json()).toMatchObject({ status: 'accepted' });
    expect(await second.json()).toMatchObject({ status: 'duplicate_delivery' });
  });

  it('rejects invalid signatures', async () => {
    const kv = new KvStore();
    kv.values.set('github/webhook-secret', 'shared-secret');
    const marker = buildReviewFindingMarker('rf_1', 'run_1');
    const body = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 17 },
      comment: { id: 901, body: `${marker} Please add tests.` }
    });

    const response = await handleGithubWebhook(await makeRequest({
      secret: 'shared-secret',
      body,
      signature: 'sha256=deadbeef',
      deliveryId: 'delivery-invalid'
    }), buildEnv(kv));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid GitHub webhook signature.'
    });
  });

  it('returns ignored for non-marker events', async () => {
    const kv = new KvStore();
    kv.values.set('github/webhook-secret', 'shared-secret');
    const body = JSON.stringify({
      action: 'created',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 17 },
      comment: { id: 901, body: 'Looks good to me.' }
    });

    const response = await handleGithubWebhook(await makeRequest({
      secret: 'shared-secret',
      body,
      deliveryId: 'delivery-ignored'
    }), buildEnv(kv));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ignored' });
  });
});
