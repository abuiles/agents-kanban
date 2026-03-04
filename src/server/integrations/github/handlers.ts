import * as tenantAuthDb from '../../tenant-auth-db';
import { badRequest } from '../../http/errors';
import { handleError, json } from '../../http/response';
import { buildIdempotencyKey } from '../idempotency';
import { normalizeGithubReplyContextEvent } from './normalize';
import { persistGithubReplyContextHints } from './reply-context-store';
import { verifyGithubWebhookSignature } from './verification';

const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

async function resolveTenantId(env: Env) {
  return tenantAuthDb.getPrimaryTenantId(env);
}

async function shouldProcessDelivery(env: Env, key: string) {
  const existing = await env.SECRETS_KV.get(key);
  if (existing) {
    return false;
  }
  await env.SECRETS_KV.put(key, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function readDeliveryId(request: Request, rawBody: string, normalizedProviderEventId: string) {
  const fromHeader = request.headers.get('x-github-delivery')?.trim();
  if (fromHeader) {
    return fromHeader;
  }
  return `${normalizedProviderEventId}:${hashText(rawBody)}`;
}

function parseGithubWebhookBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw badRequest('Invalid GitHub webhook payload.');
  }
}

export async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const tenantId = await resolveTenantId(env);
    const rawBody = await request.text();
    await verifyGithubWebhookSignature(env, tenantId, request, rawBody);

    const payload = parseGithubWebhookBody(rawBody);
    const eventType = request.headers.get('x-github-event');
    const normalized = normalizeGithubReplyContextEvent(eventType, payload);
    if (!normalized) {
      return json({ ok: true, status: 'ignored' });
    }

    const deliveryId = readDeliveryId(request, rawBody, normalized.providerEventId);
    const dedupeKey = buildIdempotencyKey({
      provider: 'github',
      tenantId,
      eventType: 'webhook.delivery',
      providerEventId: deliveryId,
      subjectId: normalized.projectPath,
      metadata: {
        reviewNumber: normalized.reviewNumber
      }
    });
    if (!(await shouldProcessDelivery(env, dedupeKey))) {
      return json({ ok: true, status: 'duplicate_delivery' });
    }

    const hintsPersisted = await persistGithubReplyContextHints({
      env,
      tenantId,
      deliveryId,
      normalized
    });

    return json({
      ok: true,
      status: 'accepted',
      hintsPersisted,
      reviewNumber: normalized.reviewNumber,
      projectPath: normalized.projectPath
    });
  } catch (error) {
    return handleError(error);
  }
}
