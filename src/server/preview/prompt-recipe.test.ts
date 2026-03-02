import { describe, expect, it, vi } from 'vitest';
import {
  PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
  inspectPromptRecipeConfiguration,
  promptRecipePreviewAdapter,
  resolvePromptRecipeExecution,
  validatePromptRecipePreviewOutput
} from './prompt-recipe';
import type { Repo, Task, AgentRun } from '../../ui/domain/types';
import type { PreviewAdapterContext } from './adapter';
import type { LlmAdapter, LlmPromptExecutionResult } from '../llm/adapter';

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

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task_1',
    repoId: 'repo_1',
    title: 'Resolve preview',
    taskPrompt: 'Resolve preview',
    acceptanceCriteria: [],
    context: { links: [] },
    status: 'REVIEW',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    repoId: 'repo_1',
    status: 'WAITING_PREVIEW',
    branchName: 'agent/task_1/run_1',
    previewStatus: 'DISCOVERING',
    evidenceStatus: 'NOT_STARTED',
    errors: [],
    startedAt: '2026-03-02T00:00:00.000Z',
    timeline: [],
    simulationProfile: 'happy_path',
    pendingEvents: [],
    executionSummary: {},
    ...overrides
  };
}

function buildContext(
  result: LlmPromptExecutionResult,
  overrides: Partial<PreviewAdapterContext> = {}
): PreviewAdapterContext {
  const adapter: LlmAdapter = {
    kind: 'codex',
    capabilities: {
      supportsResume: true,
      supportsTakeover: true
    },
    ensureInstalled: vi.fn(),
    restoreAuth: vi.fn(),
    logDiagnostics: vi.fn(),
    run: vi.fn(),
    runPrompt: vi.fn()
  };

  return {
    repo: buildRepo({
      previewAdapter: 'prompt_recipe',
      previewConfig: { promptRecipe: 'Read the checks and return the preview URL.' }
    }),
    task: buildTask(),
    run: buildRun(),
    checks: [{
      name: 'Workers Builds: minions-demo',
      status: 'completed',
      conclusion: 'success',
      summary: 'Preview URL: https://preview.example.com',
      rawSource: 'github_check_run'
    }],
    llm: {
      adapter,
      runtimeContext: {} as never,
      model: 'gpt-5.3-codex',
      reasoningEffort: 'medium',
      cwd: '/workspace/repo',
      sleepFn: vi.fn(),
      runPrompt: vi.fn().mockResolvedValue(result)
    },
    ...overrides
  };
}

describe('validatePromptRecipePreviewOutput', () => {
  it('accepts strict JSON with only previewUrl', () => {
    expect(validatePromptRecipePreviewOutput('{"previewUrl":"https://preview.example.com"}')).toEqual({
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

  it('rejects extra keys deterministically', () => {
    expect(validatePromptRecipePreviewOutput('{"previewUrl":"http://preview.example.com","note":"extra"}')).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_INVALID_KEYS',
          level: 'error',
          message: 'Prompt recipe output must contain exactly one key: "previewUrl".',
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
      rawOutput: '{"previewUrl":"https://preview.example.com"}'
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

  it('reports a configured recipe as pending executor work', () => {
    expect(inspectPromptRecipeConfiguration(buildRepo({
      previewAdapter: 'prompt_recipe',
      previewConfig: { promptRecipe: 'read checks and emit strict JSON' }
    }))).toEqual({
      compatibility: { checks: [] },
      resolution: {
        status: 'pending',
        adapter: 'prompt_recipe',
        explanation: 'Prompt-recipe preview resolution is configured and waiting for executor context.',
        diagnostics: [
          {
            code: 'PROMPT_RECIPE_CONFIG_READY',
            level: 'info',
            message: 'Prompt-recipe preview resolution has a configured prompt recipe.',
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

describe('promptRecipePreviewAdapter', () => {
  it('resolves a validated preview URL through the executor seam', async () => {
    const context = buildContext({
      status: 'success',
      elapsedMs: 420,
      rawOutput: '{"previewUrl":"https://preview.example.com"}'
    });

    const result = await promptRecipePreviewAdapter.resolve(context);

    expect(result.resolution.status).toBe('ready');
    expect(result.resolution.previewUrl).toBe('https://preview.example.com');
    expect(result.resolution.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'PROMPT_RECIPE_EXECUTOR_SELECTED',
      'PROMPT_RECIPE_EXECUTION_SUCCEEDED',
      'PROMPT_RECIPE_OUTPUT_VALID'
    ]);
    expect(context.llm?.runPrompt).toHaveBeenCalledOnce();
  });

  it('fails clearly when runtime context is unavailable', async () => {
    const result = await promptRecipePreviewAdapter.resolve(buildContext(
      {
        status: 'success',
        elapsedMs: 420,
        rawOutput: '{"previewUrl":"https://preview.example.com"}'
      },
      { llm: undefined }
    ));

    expect(result.resolution).toEqual({
      status: 'failed',
      adapter: 'prompt_recipe',
      explanation: 'Prompt-recipe preview resolution requires task, run, and executor context.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_RUNTIME_CONTEXT_MISSING',
          level: 'error',
          message: 'Prompt-recipe preview resolution could not access the selected executor context.',
          metadata: {
            hasTask: true,
            hasRun: true,
            hasLlmContext: false
          }
        }
      ]
    });
  });

  it('surfaces malformed output with validation diagnostics', async () => {
    const result = await promptRecipePreviewAdapter.resolve(buildContext({
      status: 'success',
      elapsedMs: 1200,
      rawOutput: '{"previewUrl":"http://preview.example.com","extra":true}'
    }));

    expect(result.resolution.status).toBe('failed');
    expect(result.resolution.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'PROMPT_RECIPE_EXECUTOR_SELECTED',
      'PROMPT_RECIPE_VALIDATION_FAILED',
      'PROMPT_RECIPE_INVALID_KEYS'
    ]);
  });
});
