import { describe, expect, it } from 'vitest';
import { normalizeRepoPreviewConfig, resolvePreviewAdapterKind, resolvePreviewCheckName } from './preview';
import type { Repo } from '../ui/domain/types';

describe('preview compatibility normalization', () => {
  it('maps legacy preview provider/check name to preview adapter/config', () => {
    const normalized = normalizeRepoPreviewConfig<Pick<Repo, 'previewAdapter' | 'previewConfig' | 'previewProvider' | 'previewCheckName'>>({
      previewProvider: 'cloudflare',
      previewCheckName: 'Workers Builds: minions'
    });

    expect(normalized.previewAdapter).toBe('cloudflare_checks');
    expect(normalized.previewConfig).toEqual({ checkName: 'Workers Builds: minions' });
    expect(resolvePreviewCheckName(normalized)).toBe('Workers Builds: minions');
  });

  it('preserves explicit preview adapter/config fields', () => {
    const normalized = normalizeRepoPreviewConfig<Pick<Repo, 'previewAdapter' | 'previewConfig' | 'previewProvider' | 'previewCheckName'>>({
      previewAdapter: 'prompt_recipe',
      previewConfig: { promptRecipe: 'Find preview URL from deployment logs.' }
    });

    expect(normalized.previewAdapter).toBe('prompt_recipe');
    expect(normalized.previewConfig).toEqual({ promptRecipe: 'Find preview URL from deployment logs.' });
    expect(resolvePreviewAdapterKind(normalized)).toBe('prompt_recipe');
  });
});
