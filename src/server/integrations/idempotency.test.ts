import { describe, expect, it } from 'vitest';
import { buildIdempotencyKey, isDuplicateDedupeKey, markAndCheckDedupeKey } from './idempotency';

describe('integration idempotency utilities', () => {
  it('builds deterministic keys from normalized payload shape', () => {
    const first = buildIdempotencyKey({
      provider: 'slack',
      tenantId: 'tenant_local',
      eventType: 'team_join',
      providerEventId: 'evt-1',
      subjectId: 'chan-1',
      metadata: {
        thread: '1',
        action: 'create',
        retries: 0
      }
    });

    const second = buildIdempotencyKey({
      provider: 'slack',
      tenantId: 'tenant_local',
      eventType: 'team_join',
      providerEventId: 'evt-1',
      subjectId: 'chan-1',
      metadata: {
        retries: 0,
        action: 'create',
        thread: '1'
      }
    });

    expect(first).toBe(second);
  });

  it('supports duplicate detection with a shared cache', () => {
    const key = buildIdempotencyKey({
      provider: 'gitlab',
      tenantId: 'tenant_local',
      eventType: 'merge_request',
      providerEventId: 'mr_42'
    });
    const cache = new Set<string>();

    expect(isDuplicateDedupeKey(cache, key)).toBe(false);
    expect(markAndCheckDedupeKey(cache, key)).toBe(false);
    expect(isDuplicateDedupeKey(cache, key)).toBe(true);
    expect(markAndCheckDedupeKey(cache, key)).toBe(true);
  });

  it('generates different keys for different payloads', () => {
    const base = {
      provider: 'slack' as const,
      tenantId: 'tenant_local',
      eventType: 'command',
      providerEventId: 'evt-1'
    };

    const keyA = buildIdempotencyKey(base);
    const keyB = buildIdempotencyKey({ ...base, providerEventId: 'evt-2' });

    expect(keyA).not.toBe(keyB);
  });
});
