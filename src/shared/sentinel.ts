import type { RepoSentinelConfig } from '../ui/domain/types';

export const DEFAULT_REPO_SENTINEL_CONFIG: RepoSentinelConfig = {
  enabled: false,
  globalMode: false,
  reviewGate: {
    requireChecksGreen: true,
    requireAutoReviewPass: true
  },
  mergePolicy: {
    autoMergeEnabled: true,
    method: 'squash',
    deleteBranch: true
  },
  conflictPolicy: {
    rebaseBeforeMerge: true,
    remediationEnabled: true,
    maxAttempts: 2
  }
};

type RepoSentinelLike = {
  sentinelConfig?: Partial<RepoSentinelConfig>;
};

export function normalizeRepoSentinelConfig<T extends RepoSentinelLike>(repo: T): T & { sentinelConfig: RepoSentinelConfig } {
  const maxAttempts = Number(repo.sentinelConfig?.conflictPolicy?.maxAttempts);
  return {
    ...repo,
    sentinelConfig: {
      enabled: repo.sentinelConfig?.enabled ?? DEFAULT_REPO_SENTINEL_CONFIG.enabled,
      globalMode: repo.sentinelConfig?.globalMode ?? DEFAULT_REPO_SENTINEL_CONFIG.globalMode,
      defaultGroupTag: normalizeGroupTag(repo.sentinelConfig?.defaultGroupTag),
      reviewGate: {
        requireChecksGreen: repo.sentinelConfig?.reviewGate?.requireChecksGreen ?? DEFAULT_REPO_SENTINEL_CONFIG.reviewGate.requireChecksGreen,
        requireAutoReviewPass: repo.sentinelConfig?.reviewGate?.requireAutoReviewPass ?? DEFAULT_REPO_SENTINEL_CONFIG.reviewGate.requireAutoReviewPass
      },
      mergePolicy: {
        autoMergeEnabled: repo.sentinelConfig?.mergePolicy?.autoMergeEnabled ?? DEFAULT_REPO_SENTINEL_CONFIG.mergePolicy.autoMergeEnabled,
        method: repo.sentinelConfig?.mergePolicy?.method ?? DEFAULT_REPO_SENTINEL_CONFIG.mergePolicy.method,
        deleteBranch: repo.sentinelConfig?.mergePolicy?.deleteBranch ?? DEFAULT_REPO_SENTINEL_CONFIG.mergePolicy.deleteBranch
      },
      conflictPolicy: {
        rebaseBeforeMerge: repo.sentinelConfig?.conflictPolicy?.rebaseBeforeMerge ?? DEFAULT_REPO_SENTINEL_CONFIG.conflictPolicy.rebaseBeforeMerge,
        remediationEnabled: repo.sentinelConfig?.conflictPolicy?.remediationEnabled ?? DEFAULT_REPO_SENTINEL_CONFIG.conflictPolicy.remediationEnabled,
        maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0
          ? maxAttempts
          : DEFAULT_REPO_SENTINEL_CONFIG.conflictPolicy.maxAttempts
      }
    }
  };
}

function normalizeGroupTag(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}
