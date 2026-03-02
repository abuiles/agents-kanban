import type { Repo } from '../ui/domain/types';

export const DEFAULT_PREVIEW_ADAPTER: NonNullable<Repo['previewAdapter']> = 'cloudflare_checks';

type RepoPreviewLike = Pick<Repo, 'previewAdapter' | 'previewConfig' | 'previewProvider' | 'previewCheckName'>;

export function normalizeRepoPreviewConfig<T extends RepoPreviewLike>(repo: T): T {
  const previewAdapter = repo.previewAdapter
    ?? (repo.previewProvider === 'cloudflare' ? 'cloudflare_checks' : undefined)
    ?? DEFAULT_PREVIEW_ADAPTER;
  const checkName = repo.previewConfig?.checkName ?? repo.previewCheckName;
  const promptRecipe = repo.previewConfig?.promptRecipe;
  const previewConfig = checkName || promptRecipe
    ? { ...(checkName ? { checkName } : {}), ...(promptRecipe ? { promptRecipe } : {}) }
    : undefined;

  return {
    ...repo,
    previewAdapter,
    previewConfig,
    previewProvider: repo.previewProvider ?? (previewAdapter === 'cloudflare_checks' ? 'cloudflare' : undefined),
    previewCheckName: repo.previewCheckName ?? checkName
  };
}

export function resolvePreviewAdapterKind(repo: RepoPreviewLike): NonNullable<Repo['previewAdapter']> {
  return normalizeRepoPreviewConfig(repo).previewAdapter ?? DEFAULT_PREVIEW_ADAPTER;
}

export function resolvePreviewCheckName(repo: RepoPreviewLike): string | undefined {
  const normalized = normalizeRepoPreviewConfig(repo);
  return normalized.previewConfig?.checkName ?? normalized.previewCheckName;
}
