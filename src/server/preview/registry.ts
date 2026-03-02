import type { Repo } from '../../ui/domain/types';
import { resolvePreviewAdapterKind as resolvePreviewAdapterKindFromRepo } from '../../shared/preview';
import type { PreviewAdapter } from './adapter';
import { cloudflareChecksPreviewAdapter } from './cloudflare-checks';
import { promptRecipePreviewAdapter } from './prompt-recipe';

const PREVIEW_ADAPTERS: Record<'cloudflare_checks' | 'prompt_recipe', PreviewAdapter> = {
  cloudflare_checks: cloudflareChecksPreviewAdapter,
  prompt_recipe: promptRecipePreviewAdapter
};

export function resolvePreviewAdapterKind(repo: Repo): 'cloudflare_checks' | 'prompt_recipe' {
  return resolvePreviewAdapterKindFromRepo(repo);
}

export function getPreviewAdapter(repo: Repo): PreviewAdapter {
  return PREVIEW_ADAPTERS[resolvePreviewAdapterKind(repo)];
}
