import { describe, expect, it } from 'vitest';
import { DEFAULT_REPO_SENTINEL_CONFIG, normalizeRepoSentinelConfig } from '../shared/sentinel';

describe('sentinel config normalization', () => {
  it('resolves deterministic defaults when sentinel config is omitted', () => {
    const normalized = normalizeRepoSentinelConfig({});
    expect(normalized.sentinelConfig).toEqual(DEFAULT_REPO_SENTINEL_CONFIG);
  });

  it('merges partial sentinel config while preserving defaults', () => {
    const normalized = normalizeRepoSentinelConfig({
      sentinelConfig: {
        enabled: true,
        mergePolicy: { method: 'merge', autoMergeEnabled: false, deleteBranch: false }
      }
    });

    expect(normalized.sentinelConfig).toEqual({
      ...DEFAULT_REPO_SENTINEL_CONFIG,
      enabled: true,
      mergePolicy: {
        method: 'merge',
        autoMergeEnabled: false,
        deleteBranch: false
      }
    });
  });
});
