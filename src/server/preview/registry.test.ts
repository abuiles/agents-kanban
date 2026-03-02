import { describe, expect, it } from 'vitest';
import { getPreviewAdapter, resolvePreviewAdapterKind } from './registry';
import type { Repo } from '../../ui/domain/types';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_1',
    slug: 'abuiles/minions-demo',
    defaultBranch: 'main',
    baselineUrl: 'https://example.com',
    enabled: true,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

describe('preview registry compatibility', () => {
  it('defaults to cloudflare checks in compatibility mode', () => {
    expect(resolvePreviewAdapterKind(buildRepo())).toBe('cloudflare_checks');
    expect(getPreviewAdapter(buildRepo()).kind).toBe('cloudflare_checks');
  });

  it('keeps cloudflare checks behavior while prompt recipe is not extracted yet', () => {
    const repo = buildRepo({
      previewAdapter: 'prompt_recipe',
      previewConfig: { promptRecipe: 'derive preview URL from CI logs' }
    });

    expect(resolvePreviewAdapterKind(repo)).toBe('cloudflare_checks');
    expect(getPreviewAdapter(repo).kind).toBe('cloudflare_checks');
  });
});
