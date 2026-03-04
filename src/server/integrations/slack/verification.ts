import { badRequest, unauthorized } from '../http/errors';

const DEFAULT_SIGNING_SECRET_KEY = 'slack/signing-secret';
const TEAM_SIGNING_SECRET_PREFIX = 'slack/signing-secret';
const REPLAY_WINDOW_SECONDS = 5 * 60;
const REPLAY_CACHE_TTL_SECONDS = 10 * 60;

type ParsedSlackRequest = {
  teamId: string | undefined;
  timestamp: string;
  signature: string;
};

function toHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

function readSlackHeaders(request: Request): ParsedSlackRequest {
  const teamId = request.headers.get('x-slack-team-id')?.trim();
  const timestamp = request.headers.get('x-slack-request-timestamp')?.trim();
  if (!timestamp) {
    throw unauthorized('Missing Slack request timestamp.');
  }
  if (!/^(?:\d+)$/.test(timestamp)) {
    throw unauthorized('Invalid Slack request timestamp.');
  }

  const signature = request.headers.get('x-slack-signature')?.trim();
  if (!signature || !signature.startsWith('v0=')) {
    throw unauthorized('Invalid Slack signature.');
  }

  return { teamId, timestamp, signature };
}

export async function buildSlackSignature(secret: string, timestamp: string, rawBody: string) {
  const message = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `v0=${toHex(new Uint8Array(digest))}`;
}

function sha256Hex(value: string) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) => toHex(new Uint8Array(digest)));
}

async function resolveSigningSecret(env: Env, teamId: string | undefined) {
  if (teamId) {
    const tenantSecret = await env.SECRETS_KV.get(`${TEAM_SIGNING_SECRET_PREFIX}:${teamId}`);
    if (tenantSecret && tenantSecret.trim()) {
      return tenantSecret.trim();
    }
  }

  const defaultSecret = await env.SECRETS_KV.get(DEFAULT_SIGNING_SECRET_KEY);
  return defaultSecret?.trim() || undefined;
}

function validateTimestamp(timestamp: string) {
  const parsed = Number(timestamp);
  const nowMs = Date.now();
  if (!Number.isFinite(parsed)) {
    throw unauthorized('Invalid Slack request timestamp.');
  }
  const ageSeconds = Math.abs(nowMs / 1000 - parsed);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    throw unauthorized('Slack request timestamp is outside replay window.');
  }
}

function buildReplayKey(teamId: string | undefined, timestamp: string, signature: string) {
  const scope = teamId ? `team:${teamId}` : 'team:default';
  const payload = `${scope}:${timestamp}:${signature}`;
  return sha256Hex(payload).then((digest) => `slack:replay:${digest}`);
}

export async function verifySlackRequest(
  env: Env,
  request: Request,
  rawBody: string
): Promise<{ teamId: string | undefined; timestamp: string }> {
  const headers = readSlackHeaders(request);
  validateTimestamp(headers.timestamp);

  const signingSecret = await resolveSigningSecret(env, headers.teamId);
  if (!signingSecret) {
    throw unauthorized('Missing Slack signing secret.');
  }

  const expectedSignature = await buildSlackSignature(signingSecret, headers.timestamp, rawBody);
  if (!timingSafeEqual(expectedSignature, headers.signature)) {
    throw unauthorized('Invalid Slack signature.');
  }

  const replayKey = await buildReplayKey(headers.teamId, headers.timestamp, headers.signature);
  const alreadySeen = await env.SECRETS_KV.get(replayKey);
  if (alreadySeen) {
    throw unauthorized('Replay Slack request detected.');
  }

  await env.SECRETS_KV.put(replayKey, '1', { expirationTtl: REPLAY_CACHE_TTL_SECONDS });

  return { teamId: headers.teamId, timestamp: headers.timestamp };
}

export function resolveThreadTenant(fallbackTenantId: string | undefined, teamId: string | undefined) {
  if (!teamId && !fallbackTenantId) {
    throw badRequest('Missing Slack tenant identifier.');
  }
  return teamId || fallbackTenantId!;
}
