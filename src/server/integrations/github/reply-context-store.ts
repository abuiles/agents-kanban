import type { NormalizedGitHubReplyEvent } from './normalize';

const REPLY_HINT_KEY_PREFIX = 'github/reply-context';
const REPLY_HINT_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_HINTS_PER_FINDING = 50;

export type GithubReplyContextHintRecord = {
  findingId: string;
  runId?: string;
  body: string;
  providerEventId: string;
  deliveryId: string;
  recordedAt: string;
};

type PersistedReplyHintRecord = {
  findingId: string;
  projectPath: string;
  reviewNumber: number;
  updatedAt: string;
  hints: GithubReplyContextHintRecord[];
};

function buildReplyHintStorageKey(input: {
  tenantId: string;
  projectPath: string;
  reviewNumber: number;
  findingId: string;
}) {
  return [
    REPLY_HINT_KEY_PREFIX,
    input.tenantId,
    encodeURIComponent(input.projectPath.toLowerCase()),
    String(input.reviewNumber),
    encodeURIComponent(input.findingId)
  ].join(':');
}

function parseStoredRecord(raw: string | null): PersistedReplyHintRecord | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedReplyHintRecord>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (!Array.isArray(parsed.hints) || typeof parsed.findingId !== 'string' || typeof parsed.projectPath !== 'string' || typeof parsed.reviewNumber !== 'number') {
      return undefined;
    }
    return {
      findingId: parsed.findingId,
      projectPath: parsed.projectPath,
      reviewNumber: parsed.reviewNumber,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      hints: parsed.hints
        .filter((hint): hint is GithubReplyContextHintRecord => (
          Boolean(hint)
          && typeof hint === 'object'
          && typeof hint.findingId === 'string'
          && typeof hint.body === 'string'
          && typeof hint.providerEventId === 'string'
          && typeof hint.deliveryId === 'string'
          && typeof hint.recordedAt === 'string'
        ))
        .map((hint) => ({
          findingId: hint.findingId,
          body: hint.body,
          providerEventId: hint.providerEventId,
          deliveryId: hint.deliveryId,
          recordedAt: hint.recordedAt,
          runId: typeof hint.runId === 'string' ? hint.runId : undefined
        }))
    };
  } catch {
    return undefined;
  }
}

function buildHintDedupeKey(hint: GithubReplyContextHintRecord) {
  return JSON.stringify({
    findingId: hint.findingId,
    runId: hint.runId ?? null,
    body: hint.body
  });
}

export async function persistGithubReplyContextHints(input: {
  env: Env;
  tenantId: string;
  deliveryId: string;
  normalized: NormalizedGitHubReplyEvent;
}) {
  const recordedAt = new Date().toISOString();
  let persistedCount = 0;

  await Promise.all(input.normalized.hints.map(async (hint) => {
    const key = buildReplyHintStorageKey({
      tenantId: input.tenantId,
      projectPath: input.normalized.projectPath,
      reviewNumber: input.normalized.reviewNumber,
      findingId: hint.findingId
    });

    const stored = parseStoredRecord(await input.env.SECRETS_KV.get(key));
    const nextHint: GithubReplyContextHintRecord = {
      findingId: hint.findingId,
      runId: hint.runId,
      body: hint.body,
      providerEventId: input.normalized.providerEventId,
      deliveryId: input.deliveryId,
      recordedAt
    };
    const dedupeKey = buildHintDedupeKey(nextHint);

    const existingHints = stored?.hints ?? [];
    if (existingHints.some((candidate) => buildHintDedupeKey(candidate) === dedupeKey)) {
      return;
    }

    persistedCount += 1;
    const nextRecord: PersistedReplyHintRecord = {
      findingId: hint.findingId,
      projectPath: input.normalized.projectPath,
      reviewNumber: input.normalized.reviewNumber,
      updatedAt: recordedAt,
      hints: [...existingHints, nextHint].slice(-MAX_HINTS_PER_FINDING)
    };

    await input.env.SECRETS_KV.put(key, JSON.stringify(nextRecord), {
      expirationTtl: REPLY_HINT_TTL_SECONDS
    });
  }));

  return persistedCount;
}

export async function listGithubReplyContextHints(input: {
  env: Env;
  tenantId: string;
  projectPath: string;
  reviewNumber: number;
  findingIds: string[];
}) {
  const entries = await Promise.all(input.findingIds.map(async (findingId) => {
    const key = buildReplyHintStorageKey({
      tenantId: input.tenantId,
      projectPath: input.projectPath,
      reviewNumber: input.reviewNumber,
      findingId
    });
    return [findingId, parseStoredRecord(await input.env.SECRETS_KV.get(key))] as const;
  }));

  return entries.reduce<Record<string, GithubReplyContextHintRecord[]>>((output, [findingId, record]) => {
    if (record?.hints.length) {
      output[findingId] = [...record.hints];
    }
    return output;
  }, {});
}
