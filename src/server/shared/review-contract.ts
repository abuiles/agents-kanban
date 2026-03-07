import type {
  AutoReviewMode,
  ArtifactManifest,
  ArtifactPointer,
  AutoReviewProvider,
  CodexModel,
  CodexReasoningEffort,
  LlmAdapter,
  LlmReasoningEffort,
  Repo,
  ReviewPlaybook,
  ReviewFinding,
  ReviewPromptSource,
  RunReviewArtifacts,
  Task
} from '../../ui/domain/types';
import { getAutoReviewProviderDefaultForScm } from '../../shared/scm';
import { normalizeTenantId } from '../../shared/tenant';
import { DEFAULT_AUTO_REVIEW_MODE } from '../../shared/llm';

export type ReviewArtifactContext = {
  runId: string;
  tenantId?: string;
};

export const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const REVIEW_FINDING_STATUSES = ['open', 'addressed', 'ignored'] as const;

export const REVIEW_FINDINGS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'description', 'filePath', 'lineStart', 'lineEnd', 'providerThreadId', 'status', 'replyContext'],
        properties: {
          severity: {
            type: 'string',
            enum: [...REVIEW_FINDING_SEVERITIES]
          },
          title: {
            type: 'string',
            minLength: 1
          },
          description: {
            type: 'string',
            minLength: 1
          },
          filePath: {
            anyOf: [
              {
                type: 'string',
                minLength: 1
              },
              {
                type: 'null'
              }
            ]
          },
          lineStart: {
            anyOf: [
              {
                type: 'number',
                minimum: 1
              },
              {
                type: 'null'
              }
            ]
          },
          lineEnd: {
            anyOf: [
              {
                type: 'number',
                minimum: 1
              },
              {
                type: 'null'
              }
            ]
          },
          providerThreadId: {
            anyOf: [
              {
                type: 'string',
                minLength: 1
              },
              {
                type: 'null'
              }
            ]
          },
          status: {
            type: 'string',
            enum: [...REVIEW_FINDING_STATUSES]
          },
          replyContext: {
            anyOf: [
              {
                type: 'array',
                items: { type: 'string', minLength: 1 }
              },
              {
                type: 'null'
              }
            ]
          }
        }
      }
    }
  }
} as const;

export type AutoReviewResolution = {
  enabled: boolean;
  taskMode: AutoReviewMode;
  prompt?: string;
  promptSource: ReviewPromptSource;
  provider: AutoReviewProvider;
  postInline: boolean;
  postingMode: 'platform' | 'agent';
  llmAdapter?: LlmAdapter;
  llmModel?: string;
  llmReasoningEffort?: LlmReasoningEffort;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
};

export function resolveAutoReviewConfig(
  repo: Pick<Repo, 'autoReview' | 'scmProvider'> | undefined,
  task: Pick<Task, 'uiMeta'> | undefined,
  playbooks: ReviewPlaybook[] = []
): AutoReviewResolution {
  const repoAutoReview = repo?.autoReview ?? {
    enabled: false,
    provider: getAutoReviewProviderDefaultForScm(repo?.scmProvider),
    postInline: false
  };
  const taskMode = task?.uiMeta?.autoReviewMode ?? DEFAULT_AUTO_REVIEW_MODE;
  const taskPrompt = trimText(task?.uiMeta?.autoReviewPrompt);
  const taskPlaybookId = trimText(task?.uiMeta?.autoReviewPlaybookId);
  const repoPlaybookId = trimText(repoAutoReview.playbookId);
  const effectivePlaybookId = taskPlaybookId || repoPlaybookId;
  const playbook = effectivePlaybookId
    ? playbooks.find((candidate) => candidate.playbookId === effectivePlaybookId && candidate.enabled)
    : undefined;
  const repoPrompt = trimText(repoAutoReview.prompt);
  const enabled = taskMode === 'on' ? true : taskMode === 'off' ? false : repoAutoReview.enabled;
  const playbookPrompt = trimText(playbook?.prompt);

  if (enabled && effectivePlaybookId && playbookPrompt) {
    return {
      enabled,
      taskMode,
      promptSource: 'playbook',
      prompt: playbookPrompt,
      provider: repoAutoReview.provider,
      postInline: repoAutoReview.postInline,
      postingMode: repoAutoReview.postingMode ?? 'platform',
      llmAdapter: repoAutoReview.llmAdapter,
      llmModel: repoAutoReview.llmModel ?? repoAutoReview.codexModel,
      llmReasoningEffort: repoAutoReview.llmReasoningEffort ?? repoAutoReview.codexReasoningEffort,
      codexModel: repoAutoReview.codexModel,
      codexReasoningEffort: repoAutoReview.codexReasoningEffort
    };
  }

  if (enabled && taskPrompt) {
    return {
      enabled,
      taskMode,
      promptSource: 'task',
      prompt: taskPrompt,
      provider: repoAutoReview.provider,
      postInline: repoAutoReview.postInline,
      postingMode: repoAutoReview.postingMode ?? 'platform',
      llmAdapter: repoAutoReview.llmAdapter,
      llmModel: repoAutoReview.llmModel ?? repoAutoReview.codexModel,
      llmReasoningEffort: repoAutoReview.llmReasoningEffort ?? repoAutoReview.codexReasoningEffort,
      codexModel: repoAutoReview.codexModel,
      codexReasoningEffort: repoAutoReview.codexReasoningEffort
    };
  }

  if (enabled && repoPrompt) {
    return {
      enabled,
      taskMode,
      promptSource: 'repo',
      prompt: repoPrompt,
      provider: repoAutoReview.provider,
      postInline: repoAutoReview.postInline,
      postingMode: repoAutoReview.postingMode ?? 'platform',
      llmAdapter: repoAutoReview.llmAdapter,
      llmModel: repoAutoReview.llmModel ?? repoAutoReview.codexModel,
      llmReasoningEffort: repoAutoReview.llmReasoningEffort ?? repoAutoReview.codexReasoningEffort,
      codexModel: repoAutoReview.codexModel,
      codexReasoningEffort: repoAutoReview.codexReasoningEffort
    };
  }

  return {
    enabled,
    taskMode,
    promptSource: 'native',
    provider: repoAutoReview.provider,
    postInline: repoAutoReview.postInline,
    postingMode: repoAutoReview.postingMode ?? 'platform',
    llmAdapter: repoAutoReview.llmAdapter,
    llmModel: repoAutoReview.llmModel ?? repoAutoReview.codexModel,
    llmReasoningEffort: repoAutoReview.llmReasoningEffort ?? repoAutoReview.codexReasoningEffort,
    codexModel: repoAutoReview.codexModel,
    codexReasoningEffort: repoAutoReview.codexReasoningEffort
  };
}

export type ReviewFindingsParseFailure =
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, string | number | boolean>;
    };
export type ReviewFindingsParseSuccess = { ok: true; findings: ReviewFinding[] };
export type ReviewFindingsParseResult = ReviewFindingsParseSuccess | ReviewFindingsParseFailure;

export function parseReviewFindings(raw: string | Record<string, unknown>): ReviewFindingsParseResult {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        ok: false,
        code: 'REVIEW_FINDINGS_EMPTY_OUTPUT',
        message: 'Review findings output is empty.'
      };
    }
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        code: 'REVIEW_FINDINGS_INVALID_JSON',
        message: 'Review findings output is not valid JSON.'
      };
    }
  }

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'REVIEW_FINDINGS_INVALID_PAYLOAD',
      message: 'Review findings output must be a JSON object.'
    };
  }

  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'findings') {
    return {
      ok: false,
      code: 'REVIEW_FINDINGS_INVALID_SHAPE',
      message: 'Review findings output must contain exactly one key: "findings".'
    };
  }

  const { findings: rawFindings } = raw;
  if (!Array.isArray(rawFindings)) {
    return {
      ok: false,
      code: 'REVIEW_FINDINGS_FINDINGS_NOT_ARRAY',
      message: 'Review findings output must include "findings" as an array.'
    };
  }

  const idCounts = new Map<string, number>();
  const findings: ReviewFinding[] = [];
  const errors: string[] = [];
  for (let index = 0; index < rawFindings.length; index += 1) {
    const rawFinding = rawFindings[index];
    if (!isPlainObject(rawFinding)) {
      errors.push(`findings[${index}] must be an object.`);
      continue;
    }

    const extraKeys = Object.keys(rawFinding).filter(
      (key) =>
        ![
          'severity',
          'title',
          'description',
          'filePath',
          'lineStart',
          'lineEnd',
          'providerThreadId',
          'status',
          'replyContext'
        ].includes(key)
    );
    if (extraKeys.length > 0) {
      errors.push(`findings[${index}] contains unsupported keys: ${extraKeys.join(', ')}.`);
      continue;
    }

    const severity = normalizeReviewFindingEnum(
      rawFinding.severity,
      'severity',
      REVIEW_FINDING_SEVERITIES,
      errors,
      'medium'
    );
    const title = trimText(rawFinding.title);
    const description = trimText(rawFinding.description);
    if (!title || !description) {
      if (!title) {
        errors.push(`findings[${index}].title must be a non-empty string.`);
      }
      if (!description) {
        errors.push(`findings[${index}].description must be a non-empty string.`);
      }
      continue;
    }

    const filePath = trimText(rawFinding.filePath) || undefined;
    const lineStart = normalizeLineNumber(rawFinding.lineStart, `findings[${index}].lineStart`, errors);
    const lineEnd = normalizeLineNumber(rawFinding.lineEnd, `findings[${index}].lineEnd`, errors);
    if (lineStart && lineEnd && lineStart > lineEnd) {
      errors.push(`findings[${index}].lineStart must be <= lineEnd.`);
      continue;
    }

    const providerThreadId = trimText(rawFinding.providerThreadId) || undefined;
    const status = normalizeReviewFindingEnum(
      rawFinding.status,
      'status',
      REVIEW_FINDING_STATUSES,
      errors,
      'open'
    );
    const replyContext = Array.isArray(rawFinding.replyContext)
      ? rawFinding.replyContext
        .map((entry) => trimText(entry))
        .filter((entry): entry is string => Boolean(entry))
      : undefined;

    const findingId = makeStableFindingId({
      severity,
      title,
      description,
      filePath,
      lineStart,
      lineEnd,
      providerThreadId
    }, idCounts);

    findings.push({
      findingId,
      severity,
      title,
      description,
      filePath,
      lineStart,
      lineEnd,
      providerThreadId,
      status,
      replyContext
    });
  }

  if (errors.length) {
    return {
      ok: false,
      code: 'REVIEW_FINDINGS_VALIDATION_ERROR',
      message: 'Review findings output failed schema validation.',
      details: { errorCount: errors.length, firstError: errors[0] ?? '' }
    };
  }

  return { ok: true, findings };
}

export type ReviewArtifactPointers = {
  findingsJson: ArtifactPointer;
  reviewMarkdown: ArtifactPointer;
};

export function buildReviewArtifactPointers(input: ReviewArtifactContext): ReviewArtifactPointers {
  const baseKey = `tenants/${normalizeTenantId(input.tenantId)}/runs/${input.runId}`;
  return {
    findingsJson: {
      key: `${baseKey}/review/findings.json`,
      label: 'Review findings JSON',
      url: `r2://${baseKey}/review/findings.json`
    },
    reviewMarkdown: {
      key: `${baseKey}/review/review-findings.md`,
      label: 'Review markdown',
      url: `r2://${baseKey}/review/review-findings.md`
    }
  };
}

export function attachReviewArtifactsToManifest(
  manifest: ArtifactManifest,
  input: ReviewArtifactContext
): ArtifactManifest {
  const pointers = buildReviewArtifactPointers(input);
  return {
    ...manifest,
    reviewFindingsJson: pointers.findingsJson,
    reviewMarkdown: pointers.reviewMarkdown
  };
}

export function buildReviewFindingsJsonArtifact(findings: ReviewFinding[]): string {
  return JSON.stringify({ findings }, null, 2);
}

export function buildReviewFindingsMarkdownArtifact(findings: ReviewFinding[]): string {
  if (!findings.length) {
    return [
      '# Review Findings',
      '',
      'No findings were emitted from this review run.'
    ].join('\n');
  }

  const lines: string[] = ['# Review Findings', ''];
  findings.forEach((finding, index) => {
    const lineRange = rangeToString(finding.filePath, finding.lineStart, finding.lineEnd);
    const replyBlock = finding.replyContext?.length ? `\n\nReply context:\n${finding.replyContext.map((entry) => `- ${entry}`).join('\n')}` : '';
    lines.push(
      `## Finding ${index + 1}`,
      `- id: ${finding.findingId}`,
      `- severity: ${finding.severity}`,
      `- status: ${finding.status}`,
      `- title: ${finding.title}`,
      ...(lineRange ? [`- location: ${lineRange}`] : []),
      '',
      finding.description,
      replyBlock,
      ''
    );
  });

  return lines.join('\n');
}

export function buildRunReviewArtifacts(input: ReviewArtifactContext): RunReviewArtifacts {
  const pointers = buildReviewArtifactPointers(input);
  return {
    findingsJsonKey: pointers.findingsJson.key,
    reviewMarkdownKey: pointers.reviewMarkdown.key
  };
}

function makeStableFindingId(
  finding: Pick<ReviewFinding, 'severity' | 'title' | 'description' | 'filePath' | 'lineStart' | 'lineEnd' | 'providerThreadId'>,
  idCounts: Map<string, number>
): string {
  const seed = [
    finding.severity,
    finding.title,
    finding.description,
    finding.filePath ?? '',
    finding.lineStart ?? '',
    finding.lineEnd ?? '',
    finding.providerThreadId ?? ''
  ].join('|');
  const digest = hashFNV1a32(seed);
  const key = `rf_${digest}`;
  const count = (idCounts.get(key) ?? 0) + 1;
  idCounts.set(key, count);
  return count > 1 ? `${key}-${count}` : key;
}

function hashFNV1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeReviewFindingEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowedValues: T,
  errors: string[],
  fallback: T[number]
): T[number] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (allowedValues.includes(normalized as T[number])) {
    return normalized as T[number];
  }

  if (value !== undefined) {
    errors.push(`${field} must be one of ${allowedValues.join(', ')}.`);
  }
  return fallback;
}

function normalizeLineNumber(
  value: unknown,
  field: string,
  errors: string[]
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    errors.push(`${field} must be a positive integer.`);
    return undefined;
  }
  return value;
}

function rangeToString(filePath?: string, lineStart?: number, lineEnd?: number): string | undefined {
  if (!filePath) {
    return undefined;
  }
  if (!lineStart && !lineEnd) {
    return filePath;
  }
  if (lineStart && !lineEnd) {
    return `${filePath}:${lineStart}`;
  }
  if (!lineStart && lineEnd) {
    return `${filePath}:${lineEnd}`;
  }
  if (lineStart === lineEnd) {
    return `${filePath}:${lineStart}`;
  }
  return `${filePath}:${lineStart}-${lineEnd}`;
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
