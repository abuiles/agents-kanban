import type { AgentRun, AutoReviewProvider, Repo, ScmProvider, TaskBranchSource } from '../ui/domain/types';
import { normalizeRepoCheckpointConfig } from './checkpoint';
import { normalizeRepoPreviewConfig } from './preview';
import { normalizeRepoSentinelConfig } from './sentinel';
import { normalizeTenantId } from './tenant';

export const SCM_PROVIDERS = new Set(['github', 'gitlab'] as const);

const DEFAULT_SCM_BASE_URLS: Record<ScmProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com'
};

type RepoScmLike = Pick<Partial<Repo>, 'slug' | 'scmProvider' | 'scmBaseUrl' | 'projectPath'>;

export function normalizeScmProvider(value?: string): ScmProvider {
  return value === 'gitlab' ? 'gitlab' : 'github';
}

export function normalizeScmBaseUrl(provider: ScmProvider, value?: string): string {
  const raw = (value ?? DEFAULT_SCM_BASE_URLS[provider]).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid SCM base URL: ${raw}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Invalid SCM base URL: ${raw}`);
  }

  return url.origin;
}

export function normalizeProjectPath(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed || undefined;
}

export function normalizeCredentialHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('Invalid SCM credential host.');
  }
  return trimmed;
}

export function getAutoReviewProviderDefaultForScm(scmProvider?: string): AutoReviewProvider {
  return scmProvider === 'github' ? 'github' : 'gitlab';
}

export function normalizeRepo(repo: RepoScmLike & Omit<Repo, 'slug' | 'scmProvider' | 'scmBaseUrl' | 'projectPath'>): Repo {
  const scmProvider = normalizeScmProvider(repo.scmProvider);
  const projectPath = normalizeProjectPath(repo.projectPath ?? repo.slug);
  if (!projectPath) {
    throw new Error('Repo project path is required.');
  }
  const messageExamples = (repo.commitConfig?.messageExamples ?? [])
    .map((example) => example.trim())
    .filter(Boolean);
  const commitConfig = {
    messageTemplate: repo.commitConfig?.messageTemplate?.trim() || undefined,
    messageRegex: repo.commitConfig?.messageRegex?.trim() || undefined,
    messageExamples: messageExamples.length ? messageExamples : undefined
  };

  return normalizeRepoCheckpointConfig(
    normalizeRepoSentinelConfig(
      normalizeRepoPreviewConfig({
        ...repo,
        tenantId: normalizeTenantId(repo.tenantId),
        slug: projectPath,
        scmProvider,
        scmBaseUrl: normalizeScmBaseUrl(scmProvider, repo.scmBaseUrl),
        projectPath,
        llmAuthMode: repo.llmAuthMode === 'api' ? 'api' : 'bundle',
        commitConfig: (commitConfig.messageTemplate || commitConfig.messageRegex || commitConfig.messageExamples)
          ? commitConfig
          : undefined
      })
    )
  );
}

export function getRepoScmProvider(repo: RepoScmLike): ScmProvider {
  return normalizeScmProvider(repo.scmProvider);
}

export function getRepoProjectPath(repo: RepoScmLike): string {
  const projectPath = normalizeProjectPath(repo.projectPath ?? repo.slug);
  if (!projectPath) {
    throw new Error('Repo project path is required.');
  }
  return projectPath;
}

export function getRepoScmBaseUrl(repo: RepoScmLike): string {
  return normalizeScmBaseUrl(getRepoScmProvider(repo), repo.scmBaseUrl);
}

export function getRepoHost(repo: RepoScmLike): string {
  return new URL(getRepoScmBaseUrl(repo)).host.toLowerCase();
}

export function buildRepoScmKey(repo: RepoScmLike): string {
  return `${getRepoScmProvider(repo)}:${getRepoHost(repo)}:${getRepoProjectPath(repo).toLowerCase()}`;
}

export function buildGithubApiBaseUrl(repo: RepoScmLike): string {
  const baseUrl = new URL(getRepoScmBaseUrl(repo));
  if (getRepoScmProvider(repo) !== 'github') {
    throw new Error(`GitHub adapter does not support SCM provider ${getRepoScmProvider(repo)}.`);
  }

  if (baseUrl.host.toLowerCase() === 'github.com') {
    return 'https://api.github.com';
  }

  return `${baseUrl.origin}/api/v3`;
}

export function buildGithubGitUrl(repo: RepoScmLike, pat: string): string {
  const baseUrl = new URL(getRepoScmBaseUrl(repo));
  if (getRepoScmProvider(repo) !== 'github') {
    throw new Error(`GitHub adapter does not support SCM provider ${getRepoScmProvider(repo)}.`);
  }

  return `${baseUrl.protocol}//x-access-token:${encodeURIComponent(pat)}@${baseUrl.host}/${getRepoProjectPath(repo)}.git`;
}

export function buildGitlabApiBaseUrl(repo: RepoScmLike): string {
  const baseUrl = new URL(getRepoScmBaseUrl(repo));
  if (getRepoScmProvider(repo) !== 'gitlab') {
    throw new Error(`GitLab adapter does not support SCM provider ${getRepoScmProvider(repo)}.`);
  }

  return `${baseUrl.origin}/api/v4`;
}

export function buildGitlabGitUrl(repo: RepoScmLike, token: string): string {
  const baseUrl = new URL(getRepoScmBaseUrl(repo));
  if (getRepoScmProvider(repo) !== 'gitlab') {
    throw new Error(`GitLab adapter does not support SCM provider ${getRepoScmProvider(repo)}.`);
  }

  return `${baseUrl.protocol}//oauth2:${encodeURIComponent(token)}@${baseUrl.host}/${getRepoProjectPath(repo)}.git`;
}

type ReviewMetadataLike = {
  reviewUrl?: string;
  reviewNumber?: number;
  reviewProvider?: ScmProvider;
  prUrl?: string;
  prNumber?: number;
};

type DependencyReviewMetadataLike = NonNullable<AgentRun['dependencyContext']>;
type BranchSourceReviewMetadataLike = Extract<TaskBranchSource, { kind: 'dependency_review_head' }>;

export function getRunReviewUrl(review: ReviewMetadataLike) {
  return review.reviewUrl ?? review.prUrl;
}

export function getRunReviewNumber(review: ReviewMetadataLike) {
  return review.reviewNumber ?? review.prNumber;
}

export function getRunReviewProvider(review: ReviewMetadataLike) {
  return review.reviewProvider ?? (getRunReviewUrl(review) || getRunReviewNumber(review) ? 'github' : undefined);
}

export function hasRunReview(review: ReviewMetadataLike) {
  return Boolean(getRunReviewUrl(review) || getRunReviewNumber(review));
}

export function normalizeRunReviewMetadata<T extends ReviewMetadataLike>(review: T): T {
  const reviewUrl = getRunReviewUrl(review);
  const reviewNumber = getRunReviewNumber(review);
  const reviewProvider = getRunReviewProvider(review);
  return {
    ...review,
    reviewUrl,
    reviewNumber,
    reviewProvider,
    prUrl: review.prUrl ?? reviewUrl,
    prNumber: review.prNumber ?? reviewNumber
  };
}

export function normalizeDependencyReviewMetadata<T extends DependencyReviewMetadataLike>(dependencyContext: T): T {
  const sourceReviewUrl = dependencyContext.sourceReviewUrl;
  const sourceReviewNumber = dependencyContext.sourceReviewNumber ?? dependencyContext.sourcePrNumber;
  const sourceReviewProvider = dependencyContext.sourceReviewProvider
    ?? (sourceReviewUrl || sourceReviewNumber ? 'github' : undefined);

  return {
    ...dependencyContext,
    sourceReviewUrl,
    sourceReviewNumber,
    sourceReviewProvider,
    sourcePrNumber: dependencyContext.sourcePrNumber ?? sourceReviewNumber
  };
}

export function normalizeTaskBranchSourceReviewMetadata<T extends TaskBranchSource>(branchSource: T): T {
  if (branchSource.kind !== 'dependency_review_head') {
    return branchSource;
  }

  const upstreamReviewUrl = branchSource.upstreamReviewUrl;
  const upstreamReviewNumber = branchSource.upstreamReviewNumber ?? branchSource.upstreamPrNumber;
  const upstreamReviewProvider = branchSource.upstreamReviewProvider
    ?? (upstreamReviewUrl || upstreamReviewNumber ? 'github' : undefined);

  return {
    ...branchSource,
    upstreamReviewUrl,
    upstreamReviewNumber,
    upstreamReviewProvider,
    upstreamPrNumber: branchSource.upstreamPrNumber ?? upstreamReviewNumber
  } as T;
}
