import type { RepoCheckpointConfig } from '../ui/domain/types';

export const DEFAULT_REPO_CHECKPOINT_CONFIG: RepoCheckpointConfig = {
  enabled: true,
  triggerMode: 'phase_boundary',
  contextNotes: {
    enabled: true,
    filePath: '.agentskanban/context/run-context.md',
    cleanupBeforeReview: true
  },
  reviewPrep: {
    squashBeforeFirstReviewOpen: true,
    rewriteOnChangeRequestRerun: false
  }
};

type RepoCheckpointLike = {
  checkpointConfig?: {
    enabled?: boolean;
    triggerMode?: RepoCheckpointConfig['triggerMode'];
    contextNotes?: Partial<RepoCheckpointConfig['contextNotes']>;
    reviewPrep?: Partial<RepoCheckpointConfig['reviewPrep']>;
  };
};

export function normalizeRepoCheckpointConfig<T extends RepoCheckpointLike>(repo: T): T & { checkpointConfig: RepoCheckpointConfig } {
  return {
    ...repo,
    checkpointConfig: {
      enabled: repo.checkpointConfig?.enabled ?? DEFAULT_REPO_CHECKPOINT_CONFIG.enabled,
      triggerMode: repo.checkpointConfig?.triggerMode ?? DEFAULT_REPO_CHECKPOINT_CONFIG.triggerMode,
      contextNotes: {
        enabled: repo.checkpointConfig?.contextNotes?.enabled ?? DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes.enabled,
        filePath: normalizeCheckpointPath(repo.checkpointConfig?.contextNotes?.filePath),
        cleanupBeforeReview: repo.checkpointConfig?.contextNotes?.cleanupBeforeReview
          ?? DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes.cleanupBeforeReview
      },
      reviewPrep: {
        squashBeforeFirstReviewOpen: repo.checkpointConfig?.reviewPrep?.squashBeforeFirstReviewOpen
          ?? DEFAULT_REPO_CHECKPOINT_CONFIG.reviewPrep.squashBeforeFirstReviewOpen,
        rewriteOnChangeRequestRerun: repo.checkpointConfig?.reviewPrep?.rewriteOnChangeRequestRerun
          ?? DEFAULT_REPO_CHECKPOINT_CONFIG.reviewPrep.rewriteOnChangeRequestRerun
      }
    }
  };
}

function normalizeCheckpointPath(value: string | undefined) {
  if (typeof value !== 'string') {
    return DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes.filePath;
  }
  const normalized = value.trim();
  return normalized || DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes.filePath;
}
