import { describe, expect, it } from 'vitest';
import {
  buildPromptRecipeExecutionRequest,
  PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
  inspectPromptRecipeConfiguration,
  promptRecipePreviewAdapter,
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
        explanation: 'Prompt-recipe preview resolution requires a generic LLM runtime.',
        diagnostics: [
          {
            code: 'PROMPT_RECIPE_RUNTIME_UNAVAILABLE',
            level: 'error',
            message: 'Prompt-recipe preview runtime is unavailable for this resolution attempt.',
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

describe('buildPromptRecipeExecutionRequest', () => {
  it('builds a narrow generic LLM request from repo, run, and normalized checks', () => {
    const request = buildPromptRecipeExecutionRequest({
      repo: buildRepo({
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.example.com',
        projectPath: 'group/minions-demo',
        previewAdapter: 'prompt_recipe',
        previewConfig: { promptRecipe: 'Find the one usable preview URL from the statuses.' }
      }),
      task: {
        taskId: 'task_1',
        repoId: 'repo_1',
        title: 'Resolve preview',
        taskPrompt: 'Find the preview URL.',
        acceptanceCriteria: ['one preview'],
        context: { links: [] },
        status: 'ACTIVE',
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z'
      },
      run: {
        runId: 'run_1',
        taskId: 'task_1',
        repoId: 'repo_1',
        status: 'WAITING_PREVIEW',
        branchName: 'feature/preview',
        headSha: 'a'.repeat(40),
        reviewUrl: 'https://gitlab.example.com/group/minions-demo/-/merge_requests/7',
        reviewNumber: 7,
        reviewProvider: 'gitlab',
        previewStatus: 'DISCOVERING',
        evidenceStatus: 'NOT_STARTED',
        errors: [],
        startedAt: '2026-03-02T00:00:00.000Z',
        simulationProfile: 'happy_path',
        timeline: [],
        pendingEvents: []
      },
      checks: [
        {
          name: 'workers-preview',
          detailsUrl: 'https://preview.example.workers.dev',
          summary: 'Preview URL: https://preview.example.workers.dev',
          rawSource: 'gitlab_status'
        }
      ],
      promptRecipeRuntime: {
        cwd: '/workspace/preview',
        model: 'gpt-5.3-codex',
        reasoningEffort: 'medium',
        execute: async () => ({ status: 'success', elapsedMs: 1, rawOutput: '{"previewUrl":"https://preview.example.workers.dev"}' })
      }
    });

    expect(request.cwd).toBe('/workspace/preview');
    expect(request.model).toBe('gpt-5.3-codex');
    expect(request.reasoningEffort).toBe('medium');
    expect(request.prompt).toContain('Find the one usable preview URL from the statuses.');
    expect(request.prompt).toContain('"reviewProvider": "gitlab"');
    expect(request.prompt).toContain('"rawSource": "gitlab_status"');
    expect(request.prompt).toContain('Return strict JSON matching { "previewUrl": "https://..." }.');
  });
});

describe('promptRecipePreviewAdapter', () => {
  it('resolves preview URLs through the generic LLM seam', async () => {
    let capturedPrompt = '';
    const result = await promptRecipePreviewAdapter.resolve({
      repo: buildRepo({
        previewAdapter: 'prompt_recipe',
        previewConfig: { promptRecipe: 'Use the checks to find the preview URL.' }
      }),
      task: {
        taskId: 'task_1',
        repoId: 'repo_1',
        title: 'Resolve preview',
        taskPrompt: 'Find the preview URL.',
        acceptanceCriteria: ['one preview'],
        context: { links: [] },
        status: 'ACTIVE',
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z'
      },
      run: {
        runId: 'run_1',
        taskId: 'task_1',
        repoId: 'repo_1',
        status: 'WAITING_PREVIEW',
        branchName: 'feature/preview',
        headSha: 'a'.repeat(40),
        reviewUrl: 'https://github.com/abuiles/minions-demo/pull/7',
        reviewNumber: 7,
        reviewProvider: 'github',
        previewStatus: 'DISCOVERING',
        evidenceStatus: 'NOT_STARTED',
        errors: [],
        startedAt: '2026-03-02T00:00:00.000Z',
        simulationProfile: 'happy_path',
        timeline: [],
        pendingEvents: []
      },
      checks: [
        {
          name: 'Workers Builds: minions-demo',
          summary: 'Preview Alias URL: https://preview.example.workers.dev',
          rawSource: 'github_check_run'
        }
      ],
      promptRecipeRuntime: {
        cwd: '/workspace/preview',
        model: 'gpt-5.3-codex',
        reasoningEffort: 'medium',
        async execute(request) {
          capturedPrompt = request.prompt;
          return {
            status: 'success',
            elapsedMs: 320,
            rawOutput: '{"previewUrl":"https://preview.example.workers.dev"}'
          };
        }
      }
    });

    expect(capturedPrompt).toContain('Use the checks to find the preview URL.');
    expect(result.compatibility).toEqual({ checks: [] });
    expect(result.resolution).toEqual({
      status: 'ready',
      adapter: 'prompt_recipe',
      previewUrl: 'https://preview.example.workers.dev',
      explanation: 'Prompt-recipe preview resolution returned a validated preview URL.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_EXECUTION_SUCCEEDED',
          level: 'info',
          message: 'Prompt-recipe preview resolution produced a validated preview URL.',
          metadata: { elapsedMs: 320 }
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
});
