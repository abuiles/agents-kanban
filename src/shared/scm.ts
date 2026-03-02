import type { ProviderCredential, Repo, ScmProvider } from '../ui/domain/types';

const DEFAULT_SCM_BASE_URLS: Record<ScmProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com'
};

function trimString(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getDefaultScmBaseUrl(provider: ScmProvider) {
  return DEFAULT_SCM_BASE_URLS[provider];
}

export function normalizeScmBaseUrl(baseUrl: string | undefined, provider: ScmProvider) {
  const fallback = getDefaultScmBaseUrl(provider);
  const candidate = trimString(baseUrl) ?? fallback;

  try {
    const url = new URL(candidate);
    url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export function getScmHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

export function getRepoProjectPath(repo: Pick<Repo, 'projectPath' | 'slug'>) {
  return trimString(repo.projectPath) ?? trimString(repo.slug) ?? '';
}

export function normalizeRepo(repo: Repo): Repo {
  const scmProvider = repo.scmProvider ?? 'github';
  const projectPath = getRepoProjectPath(repo);
  const scmBaseUrl = normalizeScmBaseUrl(repo.scmBaseUrl, scmProvider);

  return {
    ...repo,
    slug: trimString(repo.slug) ?? projectPath,
    scmProvider,
    scmBaseUrl,
    projectPath,
    githubAuthMode: repo.githubAuthMode ?? (scmProvider === 'github' ? 'kv_pat' : undefined),
    previewProvider: repo.previewProvider ?? (scmProvider === 'github' ? 'cloudflare' : undefined)
  };
}

export function normalizeRepos(repos: Repo[] | undefined) {
  return (repos ?? []).map((repo) => normalizeRepo(repo));
}

export function getRepoIdentityKey(repo: Pick<Repo, 'scmProvider' | 'scmBaseUrl' | 'projectPath' | 'slug'>) {
  const scmProvider = repo.scmProvider ?? 'github';
  const scmBaseUrl = normalizeScmBaseUrl(repo.scmBaseUrl, scmProvider);
  return `${scmProvider}:${scmBaseUrl.toLowerCase()}:${getRepoProjectPath(repo).toLowerCase()}`;
}

export function buildProviderCredentialId(scmProvider: ScmProvider, scmBaseUrl: string) {
  const host = getScmHost(normalizeScmBaseUrl(scmBaseUrl, scmProvider));
  return `cred_${scmProvider}_${host.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

export function normalizeProviderCredential(credential: ProviderCredential): ProviderCredential {
  const scmBaseUrl = normalizeScmBaseUrl(credential.scmBaseUrl, credential.scmProvider);
  return {
    ...credential,
    credentialId: credential.credentialId || buildProviderCredentialId(credential.scmProvider, scmBaseUrl),
    scmBaseUrl,
    host: getScmHost(scmBaseUrl)
  };
}

export function normalizeProviderCredentials(credentials: ProviderCredential[] | undefined) {
  return (credentials ?? []).map((credential) => normalizeProviderCredential(credential));
}
