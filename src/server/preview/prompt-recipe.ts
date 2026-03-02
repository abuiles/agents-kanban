import { normalizeRepoPreviewConfig } from '../../shared/preview';
import type { PreviewDiagnostic } from '../../ui/domain/types';
import type { PreviewAdapter, PreviewAdapterContext, PreviewAdapterResult, PreviewResolution } from './adapter';

export const PROMPT_RECIPE_PREVIEW_TIMEOUT_MS = 45_000;
export const PROMPT_RECIPE_DEFAULT_MODEL = 'gpt-5.3-codex';
export const PROMPT_RECIPE_DEFAULT_REASONING_EFFORT = 'medium';

const PROMPT_RECIPE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['previewUrl'],
  properties: {
    previewUrl: {
      type: 'string',
      pattern: '^https://.+'
    }
  }
} as const;

type PromptRecipePreviewPayload = {
  previewUrl: string;
};

export type PromptRecipeExecutionResult =
  | {
      status: 'success';
      elapsedMs: number;
      rawOutput: string;
    }
  | {
      status: 'failed';
      elapsedMs: number;
      message: string;
      rawOutput?: string;
    }
  | {
      status: 'timed_out';
      elapsedMs: number;
      timeoutMs: number;
      rawOutput?: string;
    };

export type PromptRecipeValidationResult =
  | {
      ok: true;
      payload: PromptRecipePreviewPayload;
      diagnostics: PreviewDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: PreviewDiagnostic[];
    };

export function validatePromptRecipePreviewOutput(rawOutput: string): PromptRecipeValidationResult {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return invalid('PROMPT_RECIPE_EMPTY_OUTPUT', 'error', 'Prompt recipe returned empty output.', { outputPresent: false });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return invalid('PROMPT_RECIPE_INVALID_JSON', 'error', 'Prompt recipe output is not valid JSON.', { outputPresent: true });
  }

  if (!isPlainObject(parsed)) {
    return invalid('PROMPT_RECIPE_INVALID_SHAPE', 'error', 'Prompt recipe output must be a JSON object.', { outputPresent: true });
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'previewUrl') {
    return invalid(
      'PROMPT_RECIPE_INVALID_KEYS',
      'error',
      'Prompt recipe output must contain exactly one key: "previewUrl".',
      { keyCount: keys.length, outputPresent: true }
    );
  }

  const previewUrl = parsed.previewUrl;
  if (typeof previewUrl !== 'string' || !previewUrl.trim()) {
    return invalid('PROMPT_RECIPE_INVALID_PREVIEW_URL', 'error', 'Prompt recipe previewUrl must be a non-empty string.', { outputPresent: true });
  }

  try {
    const url = new URL(previewUrl);
    if (url.protocol !== 'https:') {
      return invalid('PROMPT_RECIPE_INVALID_PREVIEW_URL', 'error', 'Prompt recipe previewUrl must use HTTPS.', { protocol: url.protocol });
    }
  } catch {
    return invalid('PROMPT_RECIPE_INVALID_PREVIEW_URL', 'error', 'Prompt recipe previewUrl must be an absolute HTTPS URL.', { outputPresent: true });
  }

  return {
    ok: true,
    payload: { previewUrl },
    diagnostics: [
      {
        code: 'PROMPT_RECIPE_OUTPUT_VALID',
        level: 'info',
        message: 'Prompt recipe output passed strict preview validation.',
        metadata: { outputPresent: true }
      }
    ]
  };
}

export function resolvePromptRecipeExecution(result: PromptRecipeExecutionResult): PreviewResolution {
  if (result.status === 'timed_out') {
    return {
      status: 'timed_out',
      adapter: 'prompt_recipe',
      explanation: 'Prompt-recipe preview resolution timed out before a validated preview URL was returned.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_TIMEOUT',
          level: 'error',
          message: 'Prompt-recipe preview resolution exceeded its timeout.',
          metadata: {
            elapsedMs: result.elapsedMs,
            timeoutMs: result.timeoutMs,
            rawOutputPresent: Boolean(result.rawOutput?.trim())
          }
        }
      ]
    };
  }

  if (result.status === 'failed') {
    const diagnostics: PreviewDiagnostic[] = [
      {
        code: 'PROMPT_RECIPE_EXECUTION_FAILED',
        level: 'error',
        message: result.message,
        metadata: {
          elapsedMs: result.elapsedMs,
          rawOutputPresent: Boolean(result.rawOutput?.trim())
        }
      }
    ];
    if (result.rawOutput?.trim()) {
      const validation = validatePromptRecipePreviewOutput(result.rawOutput);
      diagnostics.push(...validation.diagnostics);
    }

    return {
      status: 'failed',
      adapter: 'prompt_recipe',
      explanation: 'Prompt-recipe preview resolution failed before producing a validated preview URL.',
      diagnostics
    };
  }

  const validation = validatePromptRecipePreviewOutput(result.rawOutput);
  if (!validation.ok) {
    return {
      status: 'failed',
      adapter: 'prompt_recipe',
      explanation: 'Prompt-recipe preview resolution returned output that failed strict validation.',
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_VALIDATION_FAILED',
          level: 'error',
          message: 'Prompt recipe output failed strict preview validation.',
          metadata: {
            elapsedMs: result.elapsedMs,
            rawOutputPresent: Boolean(result.rawOutput.trim())
          }
        },
        ...validation.diagnostics
      ]
    };
  }

  return {
    status: 'ready',
    adapter: 'prompt_recipe',
    previewUrl: validation.payload.previewUrl,
    explanation: 'Prompt-recipe preview resolution returned a validated preview URL.',
    diagnostics: [
      {
        code: 'PROMPT_RECIPE_EXECUTION_SUCCEEDED',
        level: 'info',
        message: 'Prompt-recipe preview resolution produced a validated preview URL.',
        metadata: {
          elapsedMs: result.elapsedMs
        }
      },
      ...validation.diagnostics
    ]
  };
}

export function inspectPromptRecipeConfiguration(
  repo: Parameters<typeof normalizeRepoPreviewConfig>[0]
): PreviewAdapterResult {
  const normalizedRepo = normalizeRepoPreviewConfig(repo);
  const recipe = normalizedRepo.previewConfig?.promptRecipe?.trim();
  if (!recipe) {
    return {
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
    };
  }

  return {
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
  };
}

export const promptRecipePreviewAdapter: PreviewAdapter = {
  kind: 'prompt_recipe',
  async resolve(context) {
    const configuration = inspectPromptRecipeConfiguration(context.repo);
    if (configuration.resolution.status === 'failed') {
      return configuration;
    }

    if (!context.task || !context.run || !context.llm) {
      return {
        compatibility: buildCompatibility(context),
        resolution: {
          status: 'failed',
          adapter: 'prompt_recipe',
          explanation: 'Prompt-recipe preview resolution requires task, run, and executor context.',
          diagnostics: [
            {
              code: 'PROMPT_RECIPE_RUNTIME_CONTEXT_MISSING',
              level: 'error',
              message: 'Prompt-recipe preview resolution could not access the selected executor context.',
              metadata: {
                hasTask: Boolean(context.task),
                hasRun: Boolean(context.run),
                hasLlmContext: Boolean(context.llm)
              }
            }
          ]
        }
      };
    }

    const recipe = normalizeRepoPreviewConfig(context.repo).previewConfig?.promptRecipe?.trim();
    const execution = await context.llm.runPrompt(buildPromptRecipePrompt(context, recipe ?? ''), {
      timeoutMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
      outputSchema: PROMPT_RECIPE_OUTPUT_SCHEMA
    });
    const baseResolution = resolvePromptRecipeExecution(execution);
    const resolution = {
      ...baseResolution,
      diagnostics: [
        {
          code: 'PROMPT_RECIPE_EXECUTOR_SELECTED',
          level: 'info' as const,
          message: `Prompt-recipe preview resolution is using ${context.llm.adapter.kind}.`,
          metadata: {
            llmAdapter: context.llm.adapter.kind,
            llmModel: context.llm.model,
            llmReasoningEffort: context.llm.reasoningEffort ?? PROMPT_RECIPE_DEFAULT_REASONING_EFFORT,
            timeoutMs: PROMPT_RECIPE_PREVIEW_TIMEOUT_MS,
            checkCount: context.checks.length
          }
        },
        ...baseResolution.diagnostics
      ]
    };

    return {
      compatibility: buildCompatibility(context),
      resolution
    };
  }
};

function buildPromptRecipePrompt(context: PreviewAdapterContext, recipe: string) {
  const repo = context.repo;
  const task = context.task;
  const run = context.run;

  return [
    'Resolve exactly one usable preview URL for this run.',
    'Follow the customer recipe, use the supplied metadata and normalized SCM checks, and do not invent a URL.',
    'Return only strict JSON matching this shape: {"previewUrl":"https://..."}',
    'If you cannot determine a usable preview URL confidently, do not fabricate one.',
    '',
    'Customer recipe:',
    recipe,
    '',
    'Repo and run context:',
    JSON.stringify({
      repo: {
        repoId: repo.repoId,
        projectPath: repo.projectPath ?? repo.slug,
        scmProvider: repo.scmProvider ?? 'github',
        scmBaseUrl: repo.scmBaseUrl,
        defaultBranch: repo.defaultBranch,
        baselineUrl: repo.baselineUrl,
        previewAdapter: repo.previewAdapter,
        previewConfig: repo.previewConfig
      },
      task: {
        taskId: task?.taskId,
        title: task?.title,
        sourceRef: task?.sourceRef,
        baselineUrlOverride: task?.baselineUrlOverride
      },
      run: {
        runId: run?.runId,
        branchName: run?.branchName,
        headSha: run?.headSha,
        reviewUrl: run?.reviewUrl ?? run?.prUrl,
        reviewNumber: run?.reviewNumber ?? run?.prNumber,
        previewUrl: run?.previewUrl
      },
      checks: context.checks.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        summary: check.summary,
        detailsUrl: check.detailsUrl,
        htmlUrl: check.htmlUrl,
        appSlug: check.appSlug,
        rawSource: check.rawSource
      }))
    }, null, 2)
  ].join('\n');
}

function buildCompatibility(context: PreviewAdapterContext): PreviewAdapterResult['compatibility'] {
  return {
    adapter: 'prompt_recipe',
    checks: context.checks.map((check) => ({
      name: check.name,
      appSlug: check.appSlug,
      rawSource: check.rawSource,
      status: check.status,
      conclusion: check.conclusion,
      score: 0,
      matchedAdapter: 'prompt_recipe',
      extracted: false
    }))
  };
}

function invalid(
  code: string,
  level: PreviewDiagnostic['level'],
  message: string,
  metadata?: Record<string, string | number | boolean>
): PromptRecipeValidationResult {
  return {
    ok: false,
    diagnostics: [{ code, level, message, metadata }]
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
