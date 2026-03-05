import type {
  CreateRepoInput,
  CreateTaskInput,
  RepoSentinelConfigInput,
  RequestRunChangesInput,
  RetryRunInput,
  TakeOverRunInput,
  UpdateRepoInput,
  UpdateTaskInput,
  UpsertScmCredentialInput
} from '../../ui/domain/api';
import { badRequest } from './errors';
import { SCM_PROVIDERS, getAutoReviewProviderDefaultForScm } from '../../shared/scm';

const CODEX_MODELS = new Set(['gpt-5.1-codex-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'] as const);
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high'] as const);
const LLM_ADAPTERS = new Set(['codex', 'cursor_cli', 'claude_code'] as const);
const LLM_AUTH_MODES = new Set(['bundle', 'api'] as const);
const AUTO_REVIEW_PROVIDERS = new Set(['github', 'gitlab', 'jira'] as const);
const AUTO_REVIEW_POSTING_MODES = new Set(['platform', 'agent'] as const);
const AUTO_REVIEW_MODES = new Set(['inherit', 'on', 'off'] as const);
const AUTO_REVIEW_SELECTION_MODES = new Set(['all', 'include', 'exclude', 'freeform'] as const);
const RETRY_RECOVERY_MODES = new Set(['latest_checkpoint', 'fresh'] as const);
const SANDBOX_ROLES = new Set(['main', 'review'] as const);
const PREVIEW_ADAPTERS = new Set(['cloudflare_checks', 'prompt_recipe'] as const);
const SENTINEL_MERGE_METHODS = new Set(['merge', 'squash', 'rebase'] as const);
const CHECKPOINT_TRIGGER_MODES = new Set(['phase_boundary'] as const);
const TENANT_MEMBER_ROLES = new Set(['owner', 'member'] as const);
const TENANT_SEAT_STATES = new Set(['active', 'invited', 'revoked'] as const);

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

function readPositiveInteger(value: unknown, field: string, required = false): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  throw badRequest(`Invalid ${field}.`);
}

function readIsoTimestamp(value: unknown, field: string, required = false): string | undefined {
  const input = readTrimmedString(value, field, required);
  if (typeof input === 'undefined') {
    return undefined;
  }
  if (!input) {
    throw badRequest(`Invalid ${field}.`);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`Invalid ${field}.`);
  }
  return parsed.toISOString();
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

function readCommitConfig(value: unknown, field: string, required = true): CreateRepoInput['commitConfig'] | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }
  if (!isRecord(value)) {
    throw badRequest(`Invalid ${field}.`);
  }

  const messageTemplate = readTrimmedString(value.messageTemplate, `${field}.messageTemplate`, false);
  const messageRegex = readTrimmedString(value.messageRegex, `${field}.messageRegex`, false);
  const messageExamples = readStringArray(value.messageExamples, `${field}.messageExamples`, false)
    ?.map((example) => example.trim())
    .filter(Boolean);

  if (messageRegex) {
    try {
      // Validate config at write time so runs fail less often on invalid settings.
      // eslint-disable-next-line no-new
      new RegExp(messageRegex);
    } catch {
      throw badRequest(`Invalid ${field}.messageRegex.`);
    }
  }

  if (!messageTemplate && !messageRegex && !(messageExamples?.length)) {
    return undefined;
  }

  return {
    ...(messageTemplate ? { messageTemplate } : {}),
    ...(messageRegex ? { messageRegex } : {}),
    ...(messageExamples?.length ? { messageExamples } : {})
  };
}

function readAutoReviewConfig(value: unknown, field: string, required = true): NonNullable<CreateRepoInput['autoReview']> | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }

  if (!isRecord(value)) {
    throw badRequest(`Invalid ${field}.`);
  }

  const enabled = readBoolean(value.enabled, `${field}.enabled`, false);
  const prompt = readTrimmedString(value.prompt, `${field}.prompt`, false);
  const provider = readEnumValue(value.provider, `${field}.provider`, AUTO_REVIEW_PROVIDERS, false);
  const postInline = readBoolean(value.postInline, `${field}.postInline`, false);
  const postingMode = readEnumValue(value.postingMode, `${field}.postingMode`, AUTO_REVIEW_POSTING_MODES, false);
  const llmAdapter = readEnumValue(value.llmAdapter, `${field}.llmAdapter`, LLM_ADAPTERS, false);
  const llmModel = readTrimmedString(value.llmModel, `${field}.llmModel`, false);
  const llmReasoningEffort = readEnumValue(value.llmReasoningEffort, `${field}.llmReasoningEffort`, CODEX_REASONING_EFFORTS, false);
  const codexModel = readEnumValue(value.codexModel, `${field}.codexModel`, CODEX_MODELS, false);
  const codexReasoningEffort = readEnumValue(value.codexReasoningEffort, `${field}.codexReasoningEffort`, CODEX_REASONING_EFFORTS, false);

  if (llmAdapter && llmAdapter !== 'codex' && (typeof codexModel !== 'undefined' || typeof codexReasoningEffort !== 'undefined')) {
    throw badRequest(`Invalid ${field}: codex compatibility fields require llmAdapter "codex".`);
  }

  if (llmModel && codexModel && llmModel !== codexModel) {
    throw badRequest(`Invalid ${field}: llmModel and codexModel must match when both are provided.`);
  }

  if (llmReasoningEffort && codexReasoningEffort && llmReasoningEffort !== codexReasoningEffort) {
    throw badRequest(`Invalid ${field}: llmReasoningEffort and codexReasoningEffort must match when both are provided.`);
  }

  const effectiveAdapter = llmAdapter ?? ((typeof codexModel !== 'undefined' || typeof codexReasoningEffort !== 'undefined') ? 'codex' : undefined);
  const effectiveModel = llmModel ?? codexModel;
  const effectiveReasoningEffort = llmReasoningEffort ?? codexReasoningEffort;
  const normalizedCodexModel = (effectiveAdapter ?? 'codex') === 'codex'
    ? readEnumValue(codexModel ?? effectiveModel, `${field}.llmModel`, CODEX_MODELS, false)
    : codexModel;
  const normalizedCodexReasoningEffort = (effectiveAdapter ?? 'codex') === 'codex'
    ? readEnumValue(codexReasoningEffort ?? effectiveReasoningEffort, `${field}.llmReasoningEffort`, CODEX_REASONING_EFFORTS, false)
    : codexReasoningEffort;

  if ((effectiveAdapter ?? 'codex') === 'codex' && effectiveModel) {
    readEnumValue(effectiveModel, `${field}.llmModel`, CODEX_MODELS, true);
  }

  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(provider ? { provider } : {}),
    ...(typeof postInline === 'boolean' ? { postInline } : {}),
    ...(postingMode ? { postingMode } : {}),
    ...(prompt ? { prompt } : {}),
    ...(effectiveAdapter ? { llmAdapter: effectiveAdapter } : {}),
    ...(effectiveModel ? { llmModel: effectiveModel } : {}),
    ...(effectiveReasoningEffort ? { llmReasoningEffort: effectiveReasoningEffort } : {}),
    ...(normalizedCodexModel ? { codexModel: normalizedCodexModel } : {}),
    ...(normalizedCodexReasoningEffort ? { codexReasoningEffort: normalizedCodexReasoningEffort } : {}),
  };
}

function readRequestRunChangesSelection(value: unknown, field = 'reviewSelection', required = false): RequestRunChangesInput['reviewSelection'] {
  if (!required && typeof value === 'undefined') {
    return undefined as unknown as RequestRunChangesInput['reviewSelection'];
  }

  if (!isRecord(value)) {
    throw badRequest(`Invalid ${field}.`);
  }

  const mode = readEnumValue(value.mode, `${field}.mode`, AUTO_REVIEW_SELECTION_MODES, true)!;
  const findingIds = readStringArray(value.findingIds, `${field}.findingIds`, false)
    ?.map((findingId) => findingId.trim())
    .filter(Boolean);
  const instruction = readTrimmedString(value.instruction, `${field}.instruction`, false);
  const includeReplies = readBoolean(value.includeReplies, `${field}.includeReplies`, false);

  return {
    mode,
    ...(findingIds?.length ? { findingIds } : {}),
    ...(instruction ? { instruction } : {}),
    ...(typeof includeReplies === 'boolean' ? { includeReplies } : {})
  };
}

function readTaskTags(value: unknown, field: string, required = false): string[] | undefined {
  const tags = readStringArray(value, field, required);
  if (typeof tags === 'undefined') {
    return undefined;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function readSentinelConfig(
  value: unknown,
  field: string,
  required = true
): NonNullable<CreateRepoInput['sentinelConfig']> | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }
  if (!isRecord(value)) {
    throw badRequest(`Invalid ${field}.`);
  }

  const reviewGate = hasOwn(value, 'reviewGate')
    ? (() => {
        if (!isRecord(value.reviewGate)) {
          throw badRequest(`Invalid ${field}.reviewGate.`);
        }
        return {
          ...(hasOwn(value.reviewGate, 'requireChecksGreen')
            ? { requireChecksGreen: readBoolean(value.reviewGate.requireChecksGreen, `${field}.reviewGate.requireChecksGreen`, false) }
            : {}),
          ...(hasOwn(value.reviewGate, 'requireAutoReviewPass')
            ? { requireAutoReviewPass: readBoolean(value.reviewGate.requireAutoReviewPass, `${field}.reviewGate.requireAutoReviewPass`, false) }
            : {})
        };
      })()
    : undefined;
  const mergePolicy = hasOwn(value, 'mergePolicy')
    ? (() => {
        if (!isRecord(value.mergePolicy)) {
          throw badRequest(`Invalid ${field}.mergePolicy.`);
        }
        return {
          ...(hasOwn(value.mergePolicy, 'autoMergeEnabled')
            ? { autoMergeEnabled: readBoolean(value.mergePolicy.autoMergeEnabled, `${field}.mergePolicy.autoMergeEnabled`, false) }
            : {}),
          ...(hasOwn(value.mergePolicy, 'method')
            ? { method: readEnumValue(value.mergePolicy.method, `${field}.mergePolicy.method`, SENTINEL_MERGE_METHODS, false) }
            : {}),
          ...(hasOwn(value.mergePolicy, 'deleteBranch')
            ? { deleteBranch: readBoolean(value.mergePolicy.deleteBranch, `${field}.mergePolicy.deleteBranch`, false) }
            : {})
        };
      })()
    : undefined;
  const conflictPolicy = hasOwn(value, 'conflictPolicy')
    ? (() => {
        if (!isRecord(value.conflictPolicy)) {
          throw badRequest(`Invalid ${field}.conflictPolicy.`);
        }
        return {
          ...(hasOwn(value.conflictPolicy, 'rebaseBeforeMerge')
            ? { rebaseBeforeMerge: readBoolean(value.conflictPolicy.rebaseBeforeMerge, `${field}.conflictPolicy.rebaseBeforeMerge`, false) }
            : {}),
          ...(hasOwn(value.conflictPolicy, 'remediationEnabled')
            ? { remediationEnabled: readBoolean(value.conflictPolicy.remediationEnabled, `${field}.conflictPolicy.remediationEnabled`, false) }
            : {}),
          ...(hasOwn(value.conflictPolicy, 'maxAttempts')
            ? { maxAttempts: readPositiveInteger(value.conflictPolicy.maxAttempts, `${field}.conflictPolicy.maxAttempts`, false) }
            : {})
        };
      })()
    : undefined;

  return {
    ...(hasOwn(value, 'enabled') ? { enabled: readBoolean(value.enabled, `${field}.enabled`, false) } : {}),
    ...(hasOwn(value, 'globalMode') ? { globalMode: readBoolean(value.globalMode, `${field}.globalMode`, false) } : {}),
    ...(hasOwn(value, 'defaultGroupTag') ? { defaultGroupTag: readTrimmedString(value.defaultGroupTag, `${field}.defaultGroupTag`, false) } : {}),
    ...(reviewGate ? { reviewGate } : {}),
    ...(mergePolicy ? { mergePolicy } : {}),
    ...(conflictPolicy ? { conflictPolicy } : {})
  };
}

function readCheckpointConfig(
  value: unknown,
  field: string,
  required = true
): NonNullable<CreateRepoInput['checkpointConfig']> | undefined {
  if (!required && typeof value === 'undefined') {
    return undefined;
  }
  if (!isRecord(value)) {
    throw badRequest(`Invalid ${field}.`);
  }

  const contextNotes = hasOwn(value, 'contextNotes')
    ? (() => {
        if (!isRecord(value.contextNotes)) {
          throw badRequest(`Invalid ${field}.contextNotes.`);
        }
        return {
          ...(hasOwn(value.contextNotes, 'enabled')
            ? { enabled: readBoolean(value.contextNotes.enabled, `${field}.contextNotes.enabled`, false) }
            : {}),
          ...(hasOwn(value.contextNotes, 'filePath')
            ? { filePath: readTrimmedString(value.contextNotes.filePath, `${field}.contextNotes.filePath`, false) }
            : {}),
          ...(hasOwn(value.contextNotes, 'cleanupBeforeReview')
            ? { cleanupBeforeReview: readBoolean(value.contextNotes.cleanupBeforeReview, `${field}.contextNotes.cleanupBeforeReview`, false) }
            : {})
        };
      })()
    : undefined;

  const reviewPrep = hasOwn(value, 'reviewPrep')
    ? (() => {
        if (!isRecord(value.reviewPrep)) {
          throw badRequest(`Invalid ${field}.reviewPrep.`);
        }
        return {
          ...(hasOwn(value.reviewPrep, 'squashBeforeFirstReviewOpen')
            ? { squashBeforeFirstReviewOpen: readBoolean(value.reviewPrep.squashBeforeFirstReviewOpen, `${field}.reviewPrep.squashBeforeFirstReviewOpen`, false) }
            : {}),
          ...(hasOwn(value.reviewPrep, 'rewriteOnChangeRequestRerun')
            ? { rewriteOnChangeRequestRerun: readBoolean(value.reviewPrep.rewriteOnChangeRequestRerun, `${field}.reviewPrep.rewriteOnChangeRequestRerun`, false) }
            : {})
        };
      })()
    : undefined;

  return {
    ...(hasOwn(value, 'enabled') ? { enabled: readBoolean(value.enabled, `${field}.enabled`, false) } : {}),
    ...(hasOwn(value, 'triggerMode') ? { triggerMode: readEnumValue(value.triggerMode, `${field}.triggerMode`, CHECKPOINT_TRIGGER_MODES, false) } : {}),
    ...(contextNotes ? { contextNotes } : {}),
    ...(reviewPrep ? { reviewPrep } : {})
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

  const scmProvider = readEnumValue(body.scmProvider, 'scmProvider', SCM_PROVIDERS, false);
  const autoReviewConfig = hasOwn(body, 'autoReview')
    ? readAutoReviewConfig(body.autoReview, 'autoReview')
    : undefined;
  const autoReviewEnabled = autoReviewConfig?.enabled ?? false;
  const autoReviewProvider = autoReviewConfig?.provider
    ?? (autoReviewEnabled ? getAutoReviewProviderDefaultForScm(scmProvider) : 'gitlab');

  return normalizeRepoPreviewFields({
    tenantId: readTrimmedString(body.tenantId, 'tenantId', false),
    slug: slug ?? projectPath,
    scmProvider,
    scmBaseUrl: readTrimmedString(body.scmBaseUrl, 'scmBaseUrl', false),
    projectPath: projectPath ?? slug,
    llmAdapter: readEnumValue(body.llmAdapter, 'llmAdapter', LLM_ADAPTERS, false),
    llmAuthMode: readEnumValue(body.llmAuthMode, 'llmAuthMode', LLM_AUTH_MODES, false),
    llmProfileId: readTrimmedString(body.llmProfileId, 'llmProfileId', false),
    llmAuthBundleR2Key: readTrimmedString(body.llmAuthBundleR2Key, 'llmAuthBundleR2Key', false)
      ?? readTrimmedString(body.codexAuthBundleR2Key, 'codexAuthBundleR2Key', false),
    defaultBranch: readTrimmedString(body.defaultBranch, 'defaultBranch', false),
    baselineUrl: readTrimmedString(body.baselineUrl, 'baselineUrl')!,
    autoReview: {
      enabled: autoReviewEnabled,
      provider: autoReviewProvider,
      postInline: autoReviewConfig?.postInline ?? false,
      postingMode: autoReviewConfig?.postingMode ?? 'platform',
      ...(autoReviewConfig?.prompt ? { prompt: autoReviewConfig.prompt } : {}),
      ...(autoReviewConfig?.llmAdapter ? { llmAdapter: autoReviewConfig.llmAdapter } : {}),
      ...(autoReviewConfig?.llmModel ? { llmModel: autoReviewConfig.llmModel } : {}),
      ...(autoReviewConfig?.llmReasoningEffort ? { llmReasoningEffort: autoReviewConfig.llmReasoningEffort } : {}),
      ...(autoReviewConfig?.codexModel ? { codexModel: autoReviewConfig.codexModel } : {}),
      ...(autoReviewConfig?.codexReasoningEffort ? { codexReasoningEffort: autoReviewConfig.codexReasoningEffort } : {})
    },
    sentinelConfig: hasOwn(body, 'sentinelConfig')
      ? readSentinelConfig(body.sentinelConfig, 'sentinelConfig')
      : {},
    checkpointConfig: hasOwn(body, 'checkpointConfig')
      ? readCheckpointConfig(body.checkpointConfig, 'checkpointConfig')
      : {},
    enabled: readBoolean(body.enabled, 'enabled', false),
    previewMode: readEnumValue(body.previewMode, 'previewMode', new Set(['auto', 'skip'] as const), false),
    evidenceMode: readEnumValue(body.evidenceMode, 'evidenceMode', new Set(['auto', 'skip'] as const), false),
    previewAdapter: readEnumValue(body.previewAdapter, 'previewAdapter', PREVIEW_ADAPTERS, false),
    previewConfig: readPreviewConfig(body.previewConfig, 'previewConfig', false),
    commitConfig: readCommitConfig(body.commitConfig, 'commitConfig', false),
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
  if (hasOwn(body, 'tenantId')) patch.tenantId = readTrimmedString(body.tenantId, 'tenantId', false);
  if (hasOwn(body, 'scmProvider')) patch.scmProvider = readEnumValue(body.scmProvider, 'scmProvider', SCM_PROVIDERS, false);
  if (hasOwn(body, 'scmBaseUrl')) patch.scmBaseUrl = readTrimmedString(body.scmBaseUrl, 'scmBaseUrl', false);
  if (hasOwn(body, 'projectPath')) patch.projectPath = readTrimmedString(body.projectPath, 'projectPath', false);
  if (hasOwn(body, 'llmAdapter')) patch.llmAdapter = readEnumValue(body.llmAdapter, 'llmAdapter', LLM_ADAPTERS, false);
  if (hasOwn(body, 'llmAuthMode')) patch.llmAuthMode = readEnumValue(body.llmAuthMode, 'llmAuthMode', LLM_AUTH_MODES, false);
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
  if (hasOwn(body, 'commitConfig')) patch.commitConfig = readCommitConfig(body.commitConfig, 'commitConfig', false);
  if (hasOwn(body, 'previewProvider')) patch.previewProvider = readEnumValue(body.previewProvider, 'previewProvider', new Set(['cloudflare'] as const), false);
  if (hasOwn(body, 'previewCheckName')) patch.previewCheckName = readTrimmedString(body.previewCheckName, 'previewCheckName', false);
  if (hasOwn(body, 'autoReview')) patch.autoReview = readAutoReviewConfig(body.autoReview, 'autoReview', false);
  if (hasOwn(body, 'sentinelConfig')) patch.sentinelConfig = readSentinelConfig(body.sentinelConfig, 'sentinelConfig', false);
  if (hasOwn(body, 'checkpointConfig')) patch.checkpointConfig = readCheckpointConfig(body.checkpointConfig, 'checkpointConfig', false);
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
  if (patch.autoReview?.enabled && !patch.autoReview.provider && patch.scmProvider) {
    patch.autoReview.provider = getAutoReviewProviderDefaultForScm(patch.scmProvider);
  }
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
    tags: readTaskTags(body.tags, 'tags', false),
    status: readString(body.status, 'status', false) as CreateTaskInput['status'],
    autoReviewMode: readEnumValue(body.autoReviewMode, 'autoReviewMode', AUTO_REVIEW_MODES, false) ?? 'inherit',
    autoReviewPrompt: readTrimmedString(body.autoReviewPrompt, 'autoReviewPrompt', false),
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
  if (hasOwn(body, 'tags')) patch.tags = readTaskTags(body.tags, 'tags', false);
  if (hasOwn(body, 'status')) patch.status = readString(body.status, 'status', false) as UpdateTaskInput['status'];
  if (hasOwn(body, 'autoReviewMode')) patch.autoReviewMode = readEnumValue(body.autoReviewMode, 'autoReviewMode', AUTO_REVIEW_MODES, false);
  if (hasOwn(body, 'autoReviewPrompt')) patch.autoReviewPrompt = readTrimmedString(body.autoReviewPrompt, 'autoReviewPrompt', false);
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

export function parseRequestRunChangesInput(body: unknown): RequestRunChangesInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid request changes payload.');
  }

  const prompt = readTrimmedString(body.prompt, 'prompt');
  if (!prompt) {
    throw badRequest('Invalid request changes payload.');
  }

  return {
    prompt,
    reviewSelection: readRequestRunChangesSelection(body.reviewSelection, 'reviewSelection')
  };
}

export function parseRetryRunInput(body: unknown): RetryRunInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid retry payload.');
  }

  const retryInput: RetryRunInput = { recoveryMode: 'latest_checkpoint' };
  if (hasOwn(body, 'recoveryMode')) {
    retryInput.recoveryMode = readEnumValue(body.recoveryMode, 'recoveryMode', RETRY_RECOVERY_MODES, false);
  }
  if (hasOwn(body, 'checkpointId')) {
    const checkpointId = readTrimmedString(body.checkpointId, 'checkpointId', false);
    if (!checkpointId) {
      throw badRequest('Invalid checkpointId.');
    }
    retryInput.checkpointId = checkpointId;
  }
  if (retryInput.recoveryMode === 'fresh' && retryInput.checkpointId) {
    throw badRequest('checkpointId cannot be provided when recoveryMode is fresh.');
  }
  return retryInput;
}

export function parseTakeOverRunInput(body: unknown): TakeOverRunInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid takeover payload.');
  }

  const sandboxRole = hasOwn(body, 'sandboxRole')
    ? readEnumValue(body.sandboxRole, 'sandboxRole', SANDBOX_ROLES, false)
    : undefined;
  return sandboxRole ? { sandboxRole } : {};
}

export function parseUpdateRepoSentinelConfigInput(body: unknown): RepoSentinelConfigInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid sentinel config patch payload.');
  }
  return readSentinelConfig(body, 'sentinelConfig', true) ?? {};
}

export function parseStartRepoSentinelInput(body: unknown): { scopeType?: 'group' | 'global'; scopeValue?: string } {
  if (!isRecord(body)) {
    throw badRequest('Invalid sentinel start payload.');
  }
  const scopeType = hasOwn(body, 'scopeType')
    ? readEnumValue(body.scopeType, 'scopeType', new Set(['group', 'global'] as const), false)
    : undefined;
  const scopeValue = hasOwn(body, 'scopeValue')
    ? readTrimmedString(body.scopeValue, 'scopeValue', false)
    : undefined;
  return {
    ...(scopeType ? { scopeType } : {}),
    ...(scopeValue ? { scopeValue } : {})
  };
}

export type CreateTenantInput = {
  name: string;
  slug: string;
  domain?: string;
  seatLimit?: number;
  defaultSeatLimit?: number;
};

export type CreateTenantMemberInput = {
  userId: string;
  role?: 'owner' | 'member';
  seatState?: 'active' | 'invited' | 'revoked';
};

export type UpdateTenantMemberInput = {
  role?: 'owner' | 'member';
  seatState?: 'active' | 'invited' | 'revoked';
};

export type CreateTenantInviteInput = {
  email: string;
  role?: 'owner' | 'member';
};

export type AuthSignupInput = {
  email: string;
  password: string;
  displayName?: string;
  tenantName: string;
  tenantDomain?: string;
  seatLimit?: number;
  defaultSeatLimit?: number;
};

export type AuthLoginInput = {
  email: string;
  password: string;
  tenantId?: string;
};

export type SetActiveTenantInput = {
  tenantId: string;
};

export type AcceptTenantInviteInput = {
  token: string;
  password: string;
  displayName?: string;
};

export type CreateUserApiTokenInput = {
  name: string;
  scopes?: string[];
  expiresAt?: string;
};

export type PlatformAuthLoginInput = {
  email: string;
  password: string;
};

export type PlatformSupportAssumeTenantInput = {
  tenantId: string;
  reason: string;
  ttlMinutes?: number;
};

export function parseCreateTenantInput(body: unknown): CreateTenantInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid tenant payload.');
  }

  return {
    name: readTrimmedString(body.name, 'name')!,
    slug: readTrimmedString(body.slug, 'slug')!,
    domain: readTrimmedString(body.domain, 'domain', false),
    seatLimit: readPositiveInteger(body.seatLimit, 'seatLimit', false),
    defaultSeatLimit: readPositiveInteger(body.defaultSeatLimit, 'defaultSeatLimit', false)
  };
}

export function parseCreateTenantMemberInput(body: unknown): CreateTenantMemberInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid tenant member payload.');
  }

  return {
    userId: readTrimmedString(body.userId, 'userId')!,
    role: readEnumValue(body.role, 'role', TENANT_MEMBER_ROLES, false),
    seatState: readEnumValue(body.seatState, 'seatState', TENANT_SEAT_STATES, false)
  };
}

export function parseCreateTenantInviteInput(body: unknown): CreateTenantInviteInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid tenant invite payload.');
  }
  return {
    email: readTrimmedString(body.email, 'email')!,
    role: readEnumValue(body.role, 'role', TENANT_MEMBER_ROLES, false)
  };
}

export function parseUpdateTenantMemberInput(body: unknown): UpdateTenantMemberInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid tenant member patch payload.');
  }

  const patch: UpdateTenantMemberInput = {};
  if (hasOwn(body, 'role')) {
    patch.role = readEnumValue(body.role, 'role', TENANT_MEMBER_ROLES, false);
  }
  if (hasOwn(body, 'seatState')) {
    patch.seatState = readEnumValue(body.seatState, 'seatState', TENANT_SEAT_STATES, false);
  }
  return patch;
}

export function parseAuthSignupInput(body: unknown): AuthSignupInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid signup payload.');
  }

  const tenantInput = isRecord(body.tenant) ? body.tenant : undefined;
  const tenantName = readTrimmedString(tenantInput?.name ?? body.tenantName, 'tenantName')!;
  const tenantDomain = readTrimmedString(tenantInput?.domain ?? body.tenantDomain, 'tenantDomain', false);
  const seatLimit = readPositiveInteger(tenantInput?.seatLimit ?? body.seatLimit, 'seatLimit', false);
  const defaultSeatLimit = readPositiveInteger(tenantInput?.defaultSeatLimit ?? body.defaultSeatLimit, 'defaultSeatLimit', false);

  const password = readString(body.password, 'password')!;
  if (!password.length) {
    throw badRequest('Invalid password.');
  }

  return {
    email: readTrimmedString(body.email, 'email')!,
    password,
    displayName: readTrimmedString(body.displayName, 'displayName', false),
    tenantName,
    tenantDomain,
    seatLimit,
    defaultSeatLimit
  };
}

export function parseAuthLoginInput(body: unknown): AuthLoginInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid login payload.');
  }

  const password = readString(body.password, 'password')!;
  if (!password.length) {
    throw badRequest('Invalid password.');
  }

  return {
    email: readTrimmedString(body.email, 'email')!,
    password,
    tenantId: readTrimmedString(body.tenantId, 'tenantId', false)
  };
}

export function parseSetActiveTenantInput(body: unknown): SetActiveTenantInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid tenant context payload.');
  }

  return {
    tenantId: readTrimmedString(body.tenantId, 'tenantId')!
  };
}

export function parseAcceptTenantInviteInput(body: unknown): AcceptTenantInviteInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid invite accept payload.');
  }
  const token = readString(body.token, 'token')!;
  if (!token.length) {
    throw badRequest('Invalid token.');
  }
  const password = readString(body.password, 'password')!;
  if (!password.length) {
    throw badRequest('Invalid password.');
  }
  return {
    token,
    password,
    displayName: readTrimmedString(body.displayName, 'displayName', false)
  };
}

export function parseCreateUserApiTokenInput(body: unknown): CreateUserApiTokenInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid API token payload.');
  }
  const name = readTrimmedString(body.name, 'name')!;
  if (!name) {
    throw badRequest('Invalid name.');
  }
  return {
    name,
    scopes: readStringArray(body.scopes, 'scopes', false),
    expiresAt: readIsoTimestamp(body.expiresAt, 'expiresAt', false)
  };
}

export function parsePlatformAuthLoginInput(body: unknown): PlatformAuthLoginInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid platform auth payload.');
  }
  return {
    email: readTrimmedString(body.email, 'email')!,
    password: readTrimmedString(body.password, 'password')!
  };
}

export function parsePlatformSupportAssumeTenantInput(body: unknown): PlatformSupportAssumeTenantInput {
  if (!isRecord(body)) {
    throw badRequest('Invalid support session payload.');
  }
  return {
    tenantId: readTrimmedString(body.tenantId, 'tenantId')!,
    reason: readTrimmedString(body.reason, 'reason')!,
    ttlMinutes: readPositiveInteger(body.ttlMinutes, 'ttlMinutes', false)
  };
}
