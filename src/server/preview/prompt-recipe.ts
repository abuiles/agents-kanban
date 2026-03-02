import { normalizeRepoPreviewConfig } from '../../shared/preview';
import type {
  PreviewAdapter,
  PreviewAdapterResult,
  PreviewAdapterContext,
  PreviewDiagnostic,
  PreviewPromptRecipeRuntimeResult,
  PreviewResolution
} from './adapter';

export const PROMPT_RECIPE_PREVIEW_TIMEOUT_MS = 45_000;
const PROMPT_RECIPE_RESULT_SCHEMA = '{ "previewUrl": "https://..." }';

export type PromptRecipeValidationResult =
  | {
      ok: true;
      payload: { previewUrl: string };
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

export function resolvePromptRecipeExecution(result: PreviewPromptRecipeRuntimeResult): PreviewResolution {
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
  };
}

export const promptRecipePreviewAdapter: PreviewAdapter = {
  kind: 'prompt_recipe',
  async resolve(context) {
    const configuration = inspectPromptRecipeConfiguration(context.repo);
    if (configuration.resolution.diagnostics.some((diagnostic) => diagnostic.code === 'PROMPT_RECIPE_CONFIG_MISSING')) {
      return configuration;
    }

    if (!context.task || !context.run) {
      return {
        compatibility: { checks: [] },
        resolution: {
          status: 'failed',
          adapter: 'prompt_recipe',
          explanation: 'Prompt-recipe preview resolution requires task and run context.',
          diagnostics: [
            {
              code: 'PROMPT_RECIPE_CONTEXT_MISSING',
              level: 'error',
              message: 'Prompt-recipe preview resolution requires both task and run context.',
              metadata: {
                hasTask: Boolean(context.task),
                hasRun: Boolean(context.run)
              }
            }
          ]
        }
      };
    }

    if (!context.promptRecipeRuntime) {
      return configuration;
    }

    const request = buildPromptRecipeExecutionRequest(context);
    const execution = await context.promptRecipeRuntime.execute(request, PROMPT_RECIPE_PREVIEW_TIMEOUT_MS);
    return {
      compatibility: { checks: [] },
      resolution: resolvePromptRecipeExecution(execution)
    };
  }
};

export function buildPromptRecipeExecutionRequest(context: PreviewAdapterContext) {
  const recipe = normalizeRepoPreviewConfig(context.repo).previewConfig?.promptRecipe?.trim();
  if (!recipe || !context.task || !context.run || !context.promptRecipeRuntime) {
    throw new Error('Prompt-recipe preview execution request requires promptRecipe, task, run, and runtime context.');
  }

  const reviewUrl = context.run.reviewUrl ?? context.run.prUrl;
  const prompt = [
    'Resolve exactly one preview URL for this run.',
    'Follow the customer recipe and use only the provided repository, run, and SCM check data.',
    `Return strict JSON matching ${PROMPT_RECIPE_RESULT_SCHEMA}.`,
    'Do not include markdown, prose, or additional keys.',
    '',
    'Customer recipe:',
    recipe,
    '',
    'Repository context:',
    JSON.stringify({
      repoId: context.repo.repoId,
      slug: context.repo.slug,
      scmProvider: context.repo.scmProvider ?? 'github',
      scmBaseUrl: context.repo.scmBaseUrl,
      projectPath: context.repo.projectPath,
      defaultBranch: context.repo.defaultBranch,
      baselineUrl: context.repo.baselineUrl
    }, null, 2),
    '',
    'Task context:',
    JSON.stringify({
      taskId: context.task.taskId,
      title: context.task.title,
      description: context.task.description,
      taskPrompt: context.task.taskPrompt,
      acceptanceCriteria: context.task.acceptanceCriteria
    }, null, 2),
    '',
    'Run context:',
    JSON.stringify({
      runId: context.run.runId,
      branchName: context.run.branchName,
      headSha: context.run.headSha,
      reviewUrl,
      reviewNumber: context.run.reviewNumber ?? context.run.prNumber,
      reviewProvider: context.run.reviewProvider,
      previewUrl: context.run.previewUrl
    }, null, 2),
    '',
    'Normalized SCM checks:',
    JSON.stringify(context.checks, null, 2)
  ].join('\n');

  return {
    repo: context.repo,
    task: context.task,
    run: context.run,
    cwd: context.promptRecipeRuntime.cwd,
    prompt,
    model: context.promptRecipeRuntime.model,
    reasoningEffort: context.promptRecipeRuntime.reasoningEffort
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
