import type { CreateRepoInput, CreateTaskInput, UpdateRepoInput, UpdateTaskInput, UpsertScmCredentialInput } from '../../ui/domain/api';
import { badRequest } from './errors';
import { SCM_PROVIDERS } from '../../shared/scm';

const CODEX_MODELS = new Set(['gpt-5.1-codex-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'] as const);
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high'] as const);
const LLM_ADAPTERS = new Set(['codex', 'cursor_cli'] as const);
const PREVIEW_ADAPTERS = new Set(['cloudflare_checks', 'prompt_recipe'] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown, field: string, required = true): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readTrimmedString(value: unknown, field: string, required = true): string | undefined {
  const result = readString(value, field, required);
  return typeof result === 'string' ? result.trim() : result;
}

function readBoolean(value: unknown, field: string, required = false): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readStringArray(value: unknown, field: string, required = true): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readEnumValue<T extends string>(value: unknown, field: string, allowed: ReadonlySet<T>, required = true): T | undefined {
  const result = readString(value, field, required);
  if (typeof result === 'undefined') {
    return undefined;
  }

  if (allowed.has(result as T)) {
    return result as T;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readContext(value: unknown, required = true): CreateTaskInput['context'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest('Invalid context.');
  }

  const linksValue = value.links;
  if (!Array.isArray(linksValue)) {
    throw badRequest('Invalid context.links.');
  }

  const links = linksValue.map((item, index) => {
    if (!isRecord(item)) {
      throw badRequest(`Invalid context.links[${index}].`);
    }

    return {
      id: readString(item.id, `context.links[${index}].id`)!,
      label: readString(item.label, `context.links[${index}].label`)!,
      url: readString(item.url, `context.links[${index}].url`)!
    };
  });

  return {
    links,
    notes: readString(value.notes, 'context.notes', false)
  };
}

function readDependencies(value: unknown, required = true): CreateTaskInput['dependencies'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw badRequest('Invalid dependencies.');
  }

  const dependencies = value.map((item, index) => {
    if (!isRecord(item)) {
      throw badRequest(`Invalid dependencies[${index}].`);
    }

    const upstreamTaskId = readTrimmedString(item.upstreamTaskId, `dependencies[${index}].upstreamTaskId`)!;
    if (!upstreamTaskId) {
      throw badRequest(`Invalid dependencies[${index}].upstreamTaskId.`);
    }

    return {
      upstreamTaskId,
      mode: readEnumValue(item.mode, `dependencies[${index}].mode`, new Set(['review_ready'] as const))!,
      primary: readBoolean(item.primary, `dependencies[${index}].primary`, false)
    };
  });

  if (dependencies.filter((dependency) => dependency.primary).length > 1) {
    throw badRequest('Invalid dependencies: only one primary dependency is allowed.');
  }

  return dependencies;
}

function readAutomationState(value: unknown, required = true): CreateTaskInput['automationState'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest('Invalid automationState.');
  }

  return {
    autoStartEligible: readBoolean(value.autoStartEligible, 'automationState.autoStartEligible', true)!,
    autoStartedAt: readString(value.autoStartedAt, 'automationState.autoStartedAt', false),
    lastDependencyRefreshAt: readString(value.lastDependencyRefreshAt, 'automationState.lastDependencyRefreshAt', false)
  };
}

function readDependencyState(value: unknown, required = true): CreateTaskInput['dependencyState'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest('Invalid dependencyState.');
  }

  const reasonsValue = value.reasons;
  if (!Array.isArray(reasonsValue)) {
    throw badRequest('Invalid dependencyState.reasons.');
  }

  return {
    blocked: readBoolean(value.blocked, 'dependencyState.blocked', true)!,
    unblockedAt: readString(value.unblockedAt, 'dependencyState.unblockedAt', false),
    reasons: reasonsValue.map((reason, index) => {
      if (!isRecord(reason)) {
        throw badRequest(`Invalid dependencyState.reasons[${index}].`);
      }

      return {
        upstreamTaskId: readTrimmedString(reason.upstreamTaskId, `dependencyState.reasons[${index}].upstreamTaskId`)!,
        state: readEnumValue(reason.state, `dependencyState.reasons[${index}].state`, new Set(['missing', 'not_ready', 'ready'] as const))!,
        message: readString(reason.message, `dependencyState.reasons[${index}].message`)!
      };
    })
  };
}

function readBranchSource(value: unknown, required = true): CreateTaskInput['branchSource'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest('Invalid branchSource.');
  }

  return {
    kind: readEnumValue(value.kind, 'branchSource.kind', new Set(['explicit_source_ref', 'dependency_review_head', 'default_branch'] as const))!,
    upstreamTaskId: readString(value.upstreamTaskId, 'branchSource.upstreamTaskId', false),
    upstreamRunId: readString(value.upstreamRunId, 'branchSource.upstreamRunId', false),
    upstreamReviewUrl: readString(value.upstreamReviewUrl, 'branchSource.upstreamReviewUrl', false),
    upstreamReviewNumber: hasOwn(value, 'upstreamReviewNumber')
      ? (() => {
          if (typeof value.upstreamReviewNumber !== 'number' || !Number.isInteger(value.upstreamReviewNumber) || value.upstreamReviewNumber < 1) {
            throw badRequest('Invalid branchSource.upstreamReviewNumber.');
          }
          return value.upstreamReviewNumber;
        })()
      : undefined,
    upstreamReviewProvider: readEnumValue(value.upstreamReviewProvider, 'branchSource.upstreamReviewProvider', SCM_PROVIDERS, false),
    upstreamPrNumber: hasOwn(value, 'upstreamPrNumber')
      ? (() => {
          if (typeof value.upstreamPrNumber !== 'number' || !Number.isInteger(value.upstreamPrNumber) || value.upstreamPrNumber < 1) {
            throw badRequest('Invalid branchSource.upstreamPrNumber.');
          }
          return value.upstreamPrNumber;
        })()
      : undefined,
    upstreamHeadSha: readString(value.upstreamHeadSha, 'branchSource.upstreamHeadSha', false),
    resolvedRef: readString(value.resolvedRef, 'branchSource.resolvedRef')!,
    resolvedAt: readString(value.resolvedAt, 'branchSource.resolvedAt')!
  };
}

function readTaskLlmFields(body: Record<string, unknown>, mode: 'create' | 'update') {
  const hasField = (key: string) => mode === 'create' || hasOwn(body, key);

  const llmAdapter = hasField('llmAdapter')
    ? readEnumValue(body.llmAdapter, 'llmAdapter', LLM_ADAPTERS, false)
    : undefined;
  const llmModel = hasField('llmModel')
    ? readTrimmedString(body.llmModel, 'llmModel', false)
    : undefined;
  const llmReasoningEffort = hasField('llmReasoningEffort')
    ? readEnumValue(body.llmReasoningEffort, 'llmReasoningEffort', CODEX_REASONING_EFFORTS, false)
    : undefined;
  const codexModel = hasField('codexModel')
    ? readEnumValue(body.codexModel, 'codexModel', CODEX_MODELS, false)
    : undefined;
  const codexReasoningEffort = hasField('codexReasoningEffort')
    ? readEnumValue(body.codexReasoningEffort, 'codexReasoningEffort', CODEX_REASONING_EFFORTS, false)
    : undefined;

  if (llmAdapter && llmAdapter !== 'codex' && (typeof codexModel !== 'undefined' || typeof codexReasoningEffort !== 'undefined')) {
    throw badRequest('Invalid LLM payload: codex compatibility fields require llmAdapter "codex".');
  }

  if (llmModel && codexModel && llmModel !== codexModel) {
    throw badRequest('Invalid LLM payload: llmModel and codexModel must match when both are provided.');
  }

  if (llmReasoningEffort && codexReasoningEffort && llmReasoningEffort !== codexReasoningEffort) {
    throw badRequest('Invalid LLM payload: llmReasoningEffort and codexReasoningEffort must match when both are provided.');
  }

  const effectiveAdapter = llmAdapter ?? ((typeof codexModel !== 'undefined' || typeof codexReasoningEffort !== 'undefined') ? 'codex' : undefined);
  const effectiveModel = llmModel ?? codexModel;
  const effectiveReasoningEffort = llmReasoningEffort ?? codexReasoningEffort;
  const normalizedCodexModel = (effectiveAdapter ?? 'codex') === 'codex'
    ? readEnumValue(codexModel ?? effectiveModel, 'llmModel', CODEX_MODELS, false)
    : codexModel;
  const normalizedCodexReasoningEffort = (effectiveAdapter ?? 'codex') === 'codex'
    ? readEnumValue(codexReasoningEffort ?? effectiveReasoningEffort, 'llmReasoningEffort', CODEX_REASONING_EFFORTS, false)
    : codexReasoningEffort;

  if ((effectiveAdapter ?? 'codex') === 'codex' && effectiveModel) {
    readEnumValue(effectiveModel, 'llmModel', CODEX_MODELS, true);
  }

  return {
    llmAdapter: effectiveAdapter,
    llmModel: effectiveModel,
    llmReasoningEffort: effectiveReasoningEffort,
    codexModel: normalizedCodexModel,
    codexReasoningEffort: normalizedCodexReasoningEffort
  };
}

function readPreviewConfig(value: unknown, field: string, required = true): CreateRepoInput['previewConfig'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest(`Invalid ${field}.`);
  }

  const checkName = readTrimmedString(value.checkName, `${field}.checkName`, false);
  const promptRecipe = readTrimmedString(value.promptRecipe, `${field}.promptRecipe`, false);
  if (!checkName && !promptRecipe) {
    return undefined;
  }

  return {
    ...(checkName ? { checkName } : {}),
    ...(promptRecipe ? { promptRecipe } : {})
  };
}

function normalizeRepoPreviewFields<T extends {
  previewMode?: CreateRepoInput['previewMode'];
  previewAdapter?: CreateRepoInput['previewAdapter'];
  previewConfig?: CreateRepoInput['previewConfig'];
  previewProvider?: CreateRepoInput['previewProvider'];
  previewCheckName?: string;
}>(input: T): T {
  const checkName = input.previewConfig?.checkName ?? input.previewCheckName;
  if (input.previewConfig?.checkName && input.previewCheckName && input.previewConfig.checkName !== input.previewCheckName) {
    throw badRequest('Invalid preview payload: previewConfig.checkName and previewCheckName must match when both are provided.');
  }

  if (input.previewProvider === 'cloudflare' && input.previewAdapter && input.previewAdapter !== 'cloudflare_checks') {
    throw badRequest('Invalid preview payload: previewProvider "cloudflare" requires previewAdapter "cloudflare_checks".');
  }

  const previewAdapter = input.previewAdapter ?? (input.previewProvider === 'cloudflare' ? 'cloudflare_checks' : undefined);
  const previewProvider = input.previewProvider ?? (previewAdapter === 'cloudflare_checks' ? 'cloudflare' : undefined);
  const previewConfig = input.previewConfig?.promptRecipe || checkName
    ? {
        ...(checkName ? { checkName } : {}),
        ...(input.previewConfig?.promptRecipe ? { promptRecipe: input.previewConfig.promptRecipe } : {})
      }
    : input.previewConfig;

  if (previewAdapter === 'prompt_recipe' && !previewConfig?.promptRecipe) {
    throw badRequest('Invalid preview payload: previewAdapter "prompt_recipe" requires previewConfig.promptRecipe.');
  }

  return {
    ...input,
    previewAdapter,
    previewConfig,
    previewProvider,
    previewCheckName: checkName
  };
}

export async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
}

export function parseCreateRepoInput(body: unknown): CreateRepoInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid repo payload.');
  }

  const slug = readTrimmedString(body.slug, 'slug', false);
  const projectPath = readTrimmedString(body.projectPath, 'projectPath', false);
  if (!slug && !projectPath) {
    throw badRequest('Invalid repo payload: slug or projectPath is required.');
  }
  if (slug && projectPath && slug !== projectPath) {
    throw badRequest('Invalid repo payload: slug and projectPath must match when both are provided.');
  }

  return normalizeRepoPreviewFields({
    slug: slug ?? projectPath,
    scmProvider: readEnumValue(body.scmProvider, 'scmProvider', SCM_PROVIDERS, false),
    scmBaseUrl: readTrimmedString(body.scmBaseUrl, 'scmBaseUrl', false),
    projectPath: projectPath ?? slug,
    llmAdapter: readEnumValue(body.llmAdapter, 'llmAdapter', LLM_ADAPTERS, false),
    llmProfileId: readTrimmedString(body.llmProfileId, 'llmProfileId', false),
    llmAuthBundleR2Key: readTrimmedString(body.llmAuthBundleR2Key, 'llmAuthBundleR2Key', false)
      ?? readTrimmedString(body.codexAuthBundleR2Key, 'codexAuthBundleR2Key', false),
    defaultBranch: readTrimmedString(body.defaultBranch, 'defaultBranch', false),
    baselineUrl: readTrimmedString(body.baselineUrl, 'baselineUrl')!,
    enabled: readBoolean(body.enabled, 'enabled', false),
    previewMode: readEnumValue(body.previewMode, 'previewMode', new Set(['auto', 'skip'] as const), false),
    evidenceMode: readEnumValue(body.evidenceMode, 'evidenceMode', new Set(['auto', 'skip'] as const), false),
    previewAdapter: readEnumValue(body.previewAdapter, 'previewAdapter', PREVIEW_ADAPTERS, false),
    previewConfig: readPreviewConfig(body.previewConfig, 'previewConfig', false),
    previewProvider: readEnumValue(body.previewProvider, 'previewProvider', new Set(['cloudflare'] as const), false),
    previewCheckName: readTrimmedString(body.previewCheckName, 'previewCheckName', false),
    codexAuthBundleR2Key:
      readTrimmedString(body.codexAuthBundleR2Key, 'codexAuthBundleR2Key', false)
      ?? readTrimmedString(body.llmAuthBundleR2Key, 'llmAuthBundleR2Key', false)
  });
}

export function parseUpdateRepoInput(body: unknown): UpdateRepoInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid repo patch payload.');
  }

  const patch: UpdateRepoInput = {};
  if (hasOwn(body, 'slug')) patch.slug = readTrimmedString(body.slug, 'slug', false);
  if (hasOwn(body, 'scmProvider')) patch.scmProvider = readEnumValue(body.scmProvider, 'scmProvider', SCM_PROVIDERS, false);
  if (hasOwn(body, 'scmBaseUrl')) patch.scmBaseUrl = readTrimmedString(body.scmBaseUrl, 'scmBaseUrl', false);
  if (hasOwn(body, 'projectPath')) patch.projectPath = readTrimmedString(body.projectPath, 'projectPath', false);
  if (hasOwn(body, 'llmAdapter')) patch.llmAdapter = readEnumValue(body.llmAdapter, 'llmAdapter', LLM_ADAPTERS, false);
  if (hasOwn(body, 'llmProfileId')) patch.llmProfileId = readTrimmedString(body.llmProfileId, 'llmProfileId', false);
  if (hasOwn(body, 'llmAuthBundleR2Key')) patch.llmAuthBundleR2Key = readTrimmedString(body.llmAuthBundleR2Key, 'llmAuthBundleR2Key', false);
  if (patch.slug && patch.projectPath && patch.slug !== patch.projectPath) {
    throw badRequest('Invalid repo patch payload: slug and projectPath must match when both are provided.');
  }
  if (patch.slug && !patch.projectPath) patch.projectPath = patch.slug;
  if (patch.projectPath && !patch.slug) patch.slug = patch.projectPath;
  if (hasOwn(body, 'defaultBranch')) patch.defaultBranch = readTrimmedString(body.defaultBranch, 'defaultBranch', false);
  if (hasOwn(body, 'baselineUrl')) patch.baselineUrl = readTrimmedString(body.baselineUrl, 'baselineUrl', false);
  if (hasOwn(body, 'enabled')) patch.enabled = readBoolean(body.enabled, 'enabled', false);
  if (hasOwn(body, 'previewMode')) patch.previewMode = readEnumValue(body.previewMode, 'previewMode', new Set(['auto', 'skip'] as const), false);
  if (hasOwn(body, 'evidenceMode')) patch.evidenceMode = readEnumValue(body.evidenceMode, 'evidenceMode', new Set(['auto', 'skip'] as const), false);
  if (hasOwn(body, 'previewAdapter')) patch.previewAdapter = readEnumValue(body.previewAdapter, 'previewAdapter', PREVIEW_ADAPTERS, false);
  if (hasOwn(body, 'previewConfig')) patch.previewConfig = readPreviewConfig(body.previewConfig, 'previewConfig', false);
  if (hasOwn(body, 'previewProvider')) patch.previewProvider = readEnumValue(body.previewProvider, 'previewProvider', new Set(['cloudflare'] as const), false);
  if (hasOwn(body, 'previewCheckName')) patch.previewCheckName = readTrimmedString(body.previewCheckName, 'previewCheckName', false);
  if (hasOwn(body, 'codexAuthBundleR2Key')) patch.codexAuthBundleR2Key = readTrimmedString(body.codexAuthBundleR2Key, 'codexAuthBundleR2Key', false);

  if (hasOwn(body, 'previewAdapter') || hasOwn(body, 'previewConfig') || hasOwn(body, 'previewProvider') || hasOwn(body, 'previewCheckName')) {
    const normalizedPreview = normalizeRepoPreviewFields({
      previewMode: patch.previewMode,
      previewAdapter: patch.previewAdapter,
      previewConfig: patch.previewConfig,
      previewProvider: patch.previewProvider,
      previewCheckName: patch.previewCheckName
    });

    if (hasOwn(body, 'previewAdapter') || hasOwn(body, 'previewProvider')) patch.previewAdapter = normalizedPreview.previewAdapter;
    if (hasOwn(body, 'previewAdapter') || hasOwn(body, 'previewProvider')) patch.previewProvider = normalizedPreview.previewProvider;
    if (hasOwn(body, 'previewConfig') || hasOwn(body, 'previewCheckName')) patch.previewConfig = normalizedPreview.previewConfig;
    if (hasOwn(body, 'previewConfig') || hasOwn(body, 'previewCheckName')) patch.previewCheckName = normalizedPreview.previewCheckName;
  }
  if (hasOwn(body, 'llmAuthBundleR2Key') && !hasOwn(body, 'codexAuthBundleR2Key')) patch.codexAuthBundleR2Key = patch.llmAuthBundleR2Key;
  if (hasOwn(body, 'codexAuthBundleR2Key') && !hasOwn(body, 'llmAuthBundleR2Key')) patch.llmAuthBundleR2Key = patch.codexAuthBundleR2Key;
  return patch;
}

export function parseUpsertScmCredentialInput(body: unknown): UpsertScmCredentialInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid SCM credential payload.');
  }

  return {
    scmProvider: readEnumValue(body.scmProvider, 'scmProvider', SCM_PROVIDERS)!,
    host: readTrimmedString(body.host, 'host')!,
    label: readTrimmedString(body.label, 'label', false),
    token: readTrimmedString(body.token, 'token')!
  };
}

export function parseCreateTaskInput(body: unknown): CreateTaskInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid task payload.');
  }

  const llmFields = readTaskLlmFields(body, 'create');
  return {
    repoId: readString(body.repoId, 'repoId')!,
    title: readString(body.title, 'title')!,
    description: readString(body.description, 'description', false),
    sourceRef: readTrimmedString(body.sourceRef, 'sourceRef', false),
    dependencies: readDependencies(body.dependencies, false),
    dependencyState: readDependencyState(body.dependencyState, false),
    automationState: readAutomationState(body.automationState, false),
    branchSource: readBranchSource(body.branchSource, false),
    taskPrompt: readString(body.taskPrompt, 'taskPrompt')!,
    acceptanceCriteria: readStringArray(body.acceptanceCriteria, 'acceptanceCriteria')!,
    context: readContext(body.context)!,
    baselineUrlOverride: readString(body.baselineUrlOverride, 'baselineUrlOverride', false),
    status: readString(body.status, 'status', false) as CreateTaskInput['status'],
    simulationProfile: readString(body.simulationProfile, 'simulationProfile', false) as CreateTaskInput['simulationProfile'],
    ...llmFields
  };
}

export function parseUpdateTaskInput(body: unknown): UpdateTaskInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid task patch payload.');
  }

  const patch: UpdateTaskInput = {};
  const llmFields = readTaskLlmFields(body, 'update');
  if (hasOwn(body, 'repoId')) patch.repoId = readString(body.repoId, 'repoId', false);
  if (hasOwn(body, 'title')) patch.title = readString(body.title, 'title', false);
  if (hasOwn(body, 'description')) patch.description = readString(body.description, 'description', false);
  if (hasOwn(body, 'sourceRef')) patch.sourceRef = readTrimmedString(body.sourceRef, 'sourceRef', false);
  if (hasOwn(body, 'dependencies')) patch.dependencies = readDependencies(body.dependencies, false);
  if (hasOwn(body, 'dependencyState')) patch.dependencyState = readDependencyState(body.dependencyState, false);
  if (hasOwn(body, 'automationState')) patch.automationState = readAutomationState(body.automationState, false);
  if (hasOwn(body, 'branchSource')) patch.branchSource = readBranchSource(body.branchSource, false);
  if (hasOwn(body, 'taskPrompt')) patch.taskPrompt = readString(body.taskPrompt, 'taskPrompt', false);
  if (hasOwn(body, 'acceptanceCriteria')) patch.acceptanceCriteria = readStringArray(body.acceptanceCriteria, 'acceptanceCriteria', false);
  if (hasOwn(body, 'context')) patch.context = readContext(body.context, false);
  if (hasOwn(body, 'baselineUrlOverride')) patch.baselineUrlOverride = readString(body.baselineUrlOverride, 'baselineUrlOverride', false);
  if (hasOwn(body, 'status')) patch.status = readString(body.status, 'status', false) as UpdateTaskInput['status'];
  if (hasOwn(body, 'simulationProfile')) patch.simulationProfile = readString(body.simulationProfile, 'simulationProfile', false) as UpdateTaskInput['simulationProfile'];
  if (hasOwn(body, 'llmAdapter') || hasOwn(body, 'codexModel') || hasOwn(body, 'codexReasoningEffort')) patch.llmAdapter = llmFields.llmAdapter;
  if (hasOwn(body, 'llmModel') || hasOwn(body, 'codexModel')) {
    patch.llmModel = llmFields.llmModel;
    patch.codexModel = llmFields.codexModel;
  }
  if (hasOwn(body, 'llmReasoningEffort') || hasOwn(body, 'codexReasoningEffort')) {
    patch.llmReasoningEffort = llmFields.llmReasoningEffort;
    patch.codexReasoningEffort = llmFields.codexReasoningEffort;
  }
  if (hasOwn(body, 'runId')) patch.runId = readString(body.runId, 'runId', false);
  return patch;
}
