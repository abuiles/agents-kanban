import { describe, expect, it } from 'vitest';
import {
  PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
  inspectPromptRecipeConfiguration,
  resolvePromptRecipeExecution,
  validatePromptRecipePreviewOutput
} from './prompt-recipe';
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

describe('validatePromptRecipePreviewOutput', () => {
  it('accepts strict JSON with only previewUrl', () => {
    expect(validatePromptRecipePreviewOutput('{\"previewUrl\":\"https://preview.example.com\"}')).toEqual({
      ok: true,
      payload: { previewUrl: 'https://preview.example.com' },
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_OUTPUT_VALID',
          level: 'info',
          message: 'Prompt recipe output passed strict preview validation.',
          metadata: { outputPresent: true }
        }
      ]
    });
  });

  it('rejects non-json output', () => {
    expect(validatePromptRecipePreviewOutput('https://preview.example.com')).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_INVALID_JSON',
          level: 'error',
          message: 'Prompt recipe output is not valid JSON.',
          metadata: { outputPresent: true }
        }
      ]
    });
  });

  it('rejects extra keys and invalid URLs deterministically', () => {
    expect(validatePromptRecipePreviewOutput('{\"previewUrl\":\"http://preview.example.com\",\"note\":\"extra\"}')).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_INVALID_KEYS',
          level: 'error',
          message: 'Prompt recipe output must contain exactly one key: \"previewUrl\".',
          metadata: { keyCount: 2, outputPresent: true }
        }
      ]
    });
  });
});

describe('resolvePromptRecipeExecution', () => {
  it('returns a ready resolution for validated output', () => {
    expect(resolvePromptRecipeExecution({
      status: 'success',
      elapsedMs: 350,
      rawOutput: '{\"previewUrl\":\"https://preview.example.com\"}'
    })).toEqual({
      status: 'ready',
      adapter: 'prompt_recipe',
      previewUrl: 'https://preview.example.com',
      explanation: 'Prompt-recipe preview resolution returned a validated preview URL.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_EXECUTION_SUCCEEDED',
          level: 'info',
          message: 'Prompt-recipe preview resolution produced a validated preview URL.',
          metadata: { elapsedMs: 350 }
        },
        {
          code: 'PROMPT_RECIPE_OUTPUT_VALID',
          level: 'info',
          message: 'Prompt recipe output passed strict preview validation.',
          metadata: { outputPresent: true }
        }
      ]
    });
  });

  it('surfaces timeout as an explicit terminal outcome', () => {
    expect(resolvePromptRecipeExecution({
      status: 'timed_out',
      elapsedMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
      timeoutMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS
    })).toEqual({
      status: 'timed_out',
      adapter: 'prompt_recipe',
      explanation: 'Prompt-recipe preview resolution timed out before a validated preview URL was returned.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_TIMEOUT',
          level: 'error',
          message: 'Prompt-recipe preview resolution exceeded its timeout.',
          metadata: {
            elapsedMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
            timeoutMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
            rawOutputPresent: false
          }
        }
      ]
    });
  });

  it('surfaces malformed output with validation diagnostics', () => {
    expect(resolvePromptRecipeExecution({
      status: 'success',
      elapsedMs: 1200,
      rawOutput: '{\"previewUrl\":\"http://preview.example.com\",\"extra\":true}'
    })).toEqual({
      status: 'failed',
      adapter: 'prompt_recipe',
      explanation: 'Prompt-recipe preview resolution returned output that failed strict validation.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_VALIDATION_FAILED',
          level: 'error',
          message: 'Prompt recipe output failed strict preview validation.',
          metadata: {
            elapsedMs: 1200,
            rawOutputPresent: true
          }
        },
        {
          code: 'PROMPT_RECIPE_INVALID_KEYS',
          level: 'error',
          message: 'Prompt recipe output must contain exactly one key: \"previewUrl\".',
          metadata: { keyCount: 2, outputPresent: true }
        }
      ]
    });
  });
});

describe('inspectPromptRecipeConfiguration', () => {
  it('fails clearly when no prompt recipe is configured', () => {
    expect(inspectPromptRecipeConfiguration(buildRepo({
      previewAdapter: 'prompt_recipe',
      previewConfig: {}
    }))).toEqual({
      compatibility: { checks: [] },
      resolution: {
        status: 'failed',
        adapter: 'prompt_recipe',
        explanation: 'Prompt-recipe preview resolution requires previewConfig.promptRecipe.',
        diagnostics: [
          {
            code: 'PROMPT_RECIPE_CONFIG_MISSING',
            level: 'error',
            message: 'Prompt-recipe preview resolution requires a configured prompt recipe.',
            metadata: { hasPromptRecipe: false }
          }
        ]
      }
    });
  });

  it('defines the contract seam without wiring the runtime yet', () => {
    expect(inspectPromptRecipeConfiguration(buildRepo({
      previewAdapter: 'prompt_recipe',
      previewConfig: { promptRecipe: 'read checks and emit strict JSON' }
    }))).toEqual({
      compatibility: { checks: [] },
      resolution: {
        status: 'failed',
        adapter: 'prompt_recipe',
        explanation: 'Prompt-recipe preview contract is defined, but the runtime adapter is not wired yet.',
        diagnostics: [
          {
            code: 'PROMPT_RECIPE_RUNTIME_UNAVAILABLE',
            level: 'error',
            message: 'Prompt-recipe preview runtime will be implemented in a later stage.',
            metadata: {
              hasPromptRecipe: true,
              timeoutMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS
            }
          }
        ]
      }
    });
  });
});
