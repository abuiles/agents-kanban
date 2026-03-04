import { describe, expect, it } from 'vitest';
import { verifyGithubWebhookSignature } from './verification';

class KvStore {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
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

describe('verifyGithubWebhookSignature', () => {
  it('accepts a valid signature', async () => {
    const kv = new KvStore();
    kv.values.set('github/webhook-secret', 'shared-secret');
    const rawBody = JSON.stringify({ hello: 'world' });

    const request = new Request('https://example.test/api/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': await signBody('shared-secret', rawBody)
      },
      body: rawBody
    });

    await expect(verifyGithubWebhookSignature({ SECRETS_KV: kv as unknown as KVNamespace } as Env, 'tenant_local', request, rawBody)).resolves.toBeUndefined();
  });

  it('rejects when the signature does not match', async () => {
    const kv = new KvStore();
    kv.values.set('github/webhook-secret', 'shared-secret');
    const rawBody = JSON.stringify({ hello: 'world' });

    const request = new Request('https://example.test/api/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': await signBody('wrong-secret', rawBody)
      },
      body: rawBody
    });

    await expect(
      verifyGithubWebhookSignature({ SECRETS_KV: kv as unknown as KVNamespace } as Env, 'tenant_local', request, rawBody)
    ).rejects.toThrow(/Invalid GitHub webhook signature/);
  });
});
