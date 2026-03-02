import type { Repo, ScmProvider } from '../ui/domain/types';

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

export function normalizeRepo(repo: RepoScmLike & Omit<Repo, 'slug' | 'scmProvider' | 'scmBaseUrl' | 'projectPath'>): Repo {
  const scmProvider = normalizeScmProvider(repo.scmProvider);
  const projectPath = normalizeProjectPath(repo.projectPath ?? repo.slug);
  if (!projectPath) {
    throw new Error('Repo project path is required.');
  }

  return {
    ...repo,
    slug: projectPath,
    scmProvider,
    scmBaseUrl: normalizeScmBaseUrl(scmProvider, repo.scmBaseUrl),
    projectPath
  };
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
