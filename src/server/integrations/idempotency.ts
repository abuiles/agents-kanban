export type IdempotencyPayload = {
  provider: 'slack' | 'gitlab';
  tenantId: string;
  eventType: string;
  providerEventId: string;
  subjectId?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export function buildIdempotencyKey(payload: IdempotencyPayload): string {
  const canonical = {
    eventType: payload.eventType,
    providerEventId: payload.providerEventId,
    provider: payload.provider,
    tenantId: payload.tenantId,
    subjectId: payload.subjectId ?? null,
    metadata: canonicalizeRecord(payload.metadata ?? {})
  };
  return `integration.dedupe.${payload.provider}.${payload.tenantId}.${hashPayload(canonical)}`;
}

export function isDuplicateDedupeKey(cache: ReadonlySet<string>, key: string) {
  return cache.has(key);
}

export function markAndCheckDedupeKey(cache: Set<string>, key: string) {
  const hasSeen = cache.has(key);
  cache.add(key);
  return hasSeen;
}

export function buildTestDedupeKey(payload: IdempotencyPayload): string {
  return buildIdempotencyKey(payload);
}

export function buildNonce(): string {
  return crypto.randomUUID();
}

function canonicalizeRecord(record: Record<string, string | number | boolean | null>) {
  return Object.keys(record).sort().reduce<Record<string, string | number | boolean | null>>((output, key) => {
    output[key] = record[key];
    return output;
  }, {});
}

function hashPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  let hash = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 31 + serialized.charCodeAt(index)) % 1_000_000_007;
  }
  return `${hash.toString(16).padStart(8, '0')}`;
}
