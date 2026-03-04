import { unauthorized } from '../../http/errors';

const DEFAULT_WEBHOOK_SECRET_KEY = 'github/webhook-secret';
const TENANT_WEBHOOK_SECRET_PREFIX = 'github/webhook-secret';
const SIGNATURE_PREFIX = 'sha256=';

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function bytesToHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveWebhookSecret(env: Env, tenantId: string) {
  const tenantScoped = await env.SECRETS_KV.get(`${TENANT_WEBHOOK_SECRET_PREFIX}:${tenantId}`);
  if (tenantScoped?.trim()) {
    return tenantScoped.trim();
  }
  const fallback = await env.SECRETS_KV.get(DEFAULT_WEBHOOK_SECRET_KEY);
  return fallback?.trim() || undefined;
}

async function buildExpectedSignature(secret: string, rawBody: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  return `${SIGNATURE_PREFIX}${bytesToHex(signature)}`;
}

export async function verifyGithubWebhookSignature(env: Env, tenantId: string, request: Request, rawBody: string) {
  const expectedSecret = await resolveWebhookSecret(env, tenantId);
  if (!expectedSecret) {
    throw unauthorized('Missing GitHub webhook secret.');
  }

  const actualSignature = request.headers.get('x-hub-signature-256')?.trim().toLowerCase();
  if (!actualSignature || !actualSignature.startsWith(SIGNATURE_PREFIX)) {
    throw unauthorized('Missing GitHub webhook signature.');
  }

  const expectedSignature = (await buildExpectedSignature(expectedSecret, rawBody)).toLowerCase();
  if (!timingSafeEqual(actualSignature, expectedSignature)) {
    throw unauthorized('Invalid GitHub webhook signature.');
  }
}
