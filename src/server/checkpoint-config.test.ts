import { describe, expect, it } from 'vitest';
import { DEFAULT_REPO_CHECKPOINT_CONFIG, normalizeRepoCheckpointConfig } from '../shared/checkpoint';

describe('checkpoint config normalization', () => {
  it('resolves deterministic defaults when checkpoint config is omitted', () => {
    const normalized = normalizeRepoCheckpointConfig({});
    expect(normalized.checkpointConfig).toEqual(DEFAULT_REPO_CHECKPOINT_CONFIG);
  });

  it('merges partial checkpoint config while preserving defaults', () => {
    const normalized = normalizeRepoCheckpointConfig({
      checkpointConfig: {
        enabled: false,
        contextNotes: {
          filePath: ' .agentskanban/context/custom-notes.md '
        },
        reviewPrep: {
          rewriteOnChangeRequestRerun: true
        }
      }
    });

    expect(normalized.checkpointConfig).toEqual({
      ...DEFAULT_REPO_CHECKPOINT_CONFIG,
      enabled: false,
      contextNotes: {
        ...DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes,
        filePath: '.agentskanban/context/custom-notes.md'
      },
      reviewPrep: {
        ...DEFAULT_REPO_CHECKPOINT_CONFIG.reviewPrep,
        rewriteOnChangeRequestRerun: true
      }
    });
  });
});
