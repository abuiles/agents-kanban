import type { Repo } from '../../ui/domain/types';
import { resolvePreviewAdapterKind as resolvePreviewAdapterKindFromRepo } from '../../shared/preview';
import type { PreviewAdapter } from './adapter';
import { cloudflareChecksPreviewAdapter } from './cloudflare-checks';

const PREVIEW_ADAPTERS: Record<'cloudflare_checks', PreviewAdapter> = {
  cloudflare_checks: cloudflareChecksPreviewAdapter
};

export function resolvePreviewAdapterKind(repo: Repo): 'cloudflare_checks' {
  const configured = resolvePreviewAdapterKindFromRepo(repo);
  if (configured === 'prompt_recipe') {
    return 'cloudflare_checks';
  }

  return 'cloudflare_checks';
}

export function getPreviewAdapter(repo: Repo): PreviewAdapter {
  return PREVIEW_ADAPTERS[resolvePreviewAdapterKind(repo)];
}
