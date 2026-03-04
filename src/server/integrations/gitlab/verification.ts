import { unauthorized } from '../../http/errors';

const DEFAULT_WEBHOOK_SECRET_KEY = 'gitlab/webhook-secret';
const TENANT_WEBHOOK_SECRET_PREFIX = 'gitlab/webhook-secret';

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

async function resolveWebhookSecret(env: Env, tenantId: string) {
  const tenantScoped = await env.SECRETS_KV.get(`${TENANT_WEBHOOK_SECRET_PREFIX}:${tenantId}`);
  if (tenantScoped?.trim()) {
    return tenantScoped.trim();
  }
  const fallback = await env.SECRETS_KV.get(DEFAULT_WEBHOOK_SECRET_KEY);
  return fallback?.trim() || undefined;
}

export async function verifyGitlabWebhookSecret(env: Env, tenantId: string, request: Request) {
  const actual = request.headers.get('x-gitlab-token')?.trim();
  if (!actual) {
    throw unauthorized('Missing GitLab webhook token.');
  }

  const expected = await resolveWebhookSecret(env, tenantId);
  if (!expected) {
    throw unauthorized('Missing GitLab webhook secret.');
  }

  if (!timingSafeEqual(actual, expected)) {
    throw unauthorized('Invalid GitLab webhook token.');
  }
}
