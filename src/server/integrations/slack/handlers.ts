import type { IntegrationIssueRef } from '../interfaces';
import type { CreateTaskInput } from '../../../ui/domain/api';
import type { Repo } from '../../../ui/domain/types';
import { badRequest } from '../../http/errors';
import { handleError, json } from '../../http/response';
import * as tenantAuthDb from '../../tenant-auth-db';
import { createJiraIssueSourceIntegrationFromEnv } from '../jira/client';
import { scheduleRunJob } from '../../run-orchestrator';
import { buildIdempotencyKey } from '../idempotency';
import {
  parseJiraFastPathIssueKey,
  parseReviewFastPathInput,
  parseSlackEventBody,
  parseSlackInteractionBody,
  parseSlackSlashCommandBody,
  type ParsedSlackInteraction,
  type SlackReviewFastPathInput
} from './payload';
import { resolveThreadTenant, verifySlackRequest } from './verification';
import { mirrorRunLifecycleMilestone } from './timeline';
import { addSlackReaction, fetchSlackThreadMessages, postSlackChannelMessage, postSlackThreadMessage } from './client';
import { resolveIntegrationConfig } from '../config-resolution';
import { getRepoHost, getRepoProjectPath } from '../../../shared/scm';
import {
  parseSlackIntentWithLlm,
  resolveSlackIntentSettings,
  type SlackIntentParseResult
} from './intent';

const DEFAULT_TASK_ID_PREFIX = 'issue';
const DEFAULT_REVIEW_TASK_ID_PREFIX = 'review';
const DEFAULT_REVIEW_ROUND = 0;
const BOARD_OBJECT_NAME = 'agentboard';
const SOURCE_REF = 'main';
const JIRA_LLM_ADAPTER: CreateTaskInput['llmAdapter'] = 'codex';
const DEFAULT_TASK_LLM_MODEL: CreateTaskInput['codexModel'] = 'gpt-5.1-codex-mini';
const JIRA_LLM_REASONING_EFFORT: CreateTaskInput['codexReasoningEffort'] = 'medium';
const FALLBACK_DISAMBIGUATION_WARNING = 'No matching repository was auto-selected for this issue.';
const DISAMBIGUATION_MULTIPLE_MAPPINGS_MESSAGE = 'Multiple repositories are mapped for Jira project';
const DISAMBIGUATION_NO_MAPPING_MESSAGE = 'No active mapping exists for project';
const INGRESS_DEDUPE_TTL_SECONDS = 10 * 60;
const KANVY_HELP_TEXT = [
  'Usage: `/kanvy fix <JIRA_KEY>`, `/kanvy review <MR_NUMBER|MR_URL>`, or `/kanvy help`.',
  'Examples:',
  '- Jira fast-path: `/kanvy fix ABC-123`',
  '- Review fast-path: `/kanvy review 1234`',
  '- Review fast-path URL: `/kanvy review https://github.com/abuiles/agents-kanban/pull/101`',
  '- Free-text flow: `/kanvy Investigate flaky checkout tests and propose a fix plan`'
].join('\n');
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const AUTO_CREATE_CONFIDENCE_THRESHOLD = 0.8;
const JIRA_TASK_TRANSFORM_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_JIRA_API_PATH_PREFIX = '/rest/api/3/issue';
const MAX_LOG_MESSAGE_CHARS = 300;
const MAX_TASK_TITLE_CHARS = 120;
const MAX_TASK_DESCRIPTION_CHARS = 320;
const MAX_SLACK_PROMPT_PREVIEW_CHARS = 420;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/i;
const REVIEW_INTENT_FALLBACK_MODELS = ['gpt-4.1-mini', 'gpt-4o-mini'] as const;

type SlackLifecycleCheckpoint = 'received' | 'deduped' | 'jira_fetch_started' | 'jira_fetch_failed' | 'task_started';

type RepoDisambiguationChoice = {
  repoId: string;
  label: string;
};

type ReviewRepoDisambiguationChoice = {
  repoId: string;
  label: string;
  reviewProvider: 'github' | 'gitlab';
};

type LlmReviewIntent = {
  isReview: boolean;
  reviewNumber?: number;
  reviewUrl?: string;
  providerHint?: 'github' | 'gitlab';
};

function shouldAttemptReviewIntentLlm(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('review')
    || normalized.includes('merge request')
    || normalized.includes('mr ')
    || normalized.includes('mr#')
    || normalized.includes(' pr ')
    || normalized.includes('pr#');
}

type ResolvedReviewCommand = {
  reviewNumber: number;
  reviewUrl?: string;
  reviewProvider: 'github' | 'gitlab';
  sourceRef: string;
};

type RunKickoff = {
  taskId: string;
  runId: string;
};

function buildTaskIdFromIssue(issueKey: string) {
  return `${DEFAULT_TASK_ID_PREFIX}:${issueKey}`;
}

function buildTaskIdFromReview(reviewProvider: 'github' | 'gitlab', reviewNumber: number) {
  return `${DEFAULT_REVIEW_TASK_ID_PREFIX}:${reviewProvider}:${reviewNumber}`;
}

function issueProjectKeyFromIssue(issueKey: string) {
  const match = issueKey.match(/^[A-Z][A-Z0-9_]*-/i);
  if (!match) {
    return issueKey;
  }
  return match[0].slice(0, -1).toUpperCase();
}

function executionContextOrNoop(ctx?: ExecutionContext<unknown>): ExecutionContext<unknown> {
  return ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext<unknown>);
}

function toReadableErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unknown error.';
}

function sanitizeErrorMessageForLog(message: string | undefined) {
  if (!message) {
    return 'Unknown error.';
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/gi, 'Basic [REDACTED]')
    .replace(/token=[^&\s]+/gi, 'token=[REDACTED]')
    .slice(0, MAX_LOG_MESSAGE_CHARS);
}

function parseJiraFailureCategory(error: unknown): { category: 'network' | 'timeout' | 'http_status' | 'bad_request' | 'unknown'; status?: number } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Unable to reach Jira issue endpoint')) {
    return { category: 'network' };
  }
  if (message.toLowerCase().includes('timed out')) {
    return { category: 'timeout' };
  }
  const statusMatch = message.match(/\((\d{3})\)/);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1]!, 10);
    if (Number.isFinite(status)) {
      return { category: 'http_status', status };
    }
  }
  if (message.startsWith('Invalid Jira issue key') || message.startsWith('Jira issue')) {
    return { category: 'bad_request' };
  }
  return { category: 'unknown' };
}

function resolveJiraRequestTarget(env: Env, issueKey: string): { host: string; path: string } {
  const envValues = env as unknown as Record<string, string | undefined>;
  const rawBase = envValues.JIRA_API_BASE_URL ?? envValues.JIRA_API_URL ?? '';
  const fallbackPath = `${DEFAULT_JIRA_API_PATH_PREFIX}/${issueKey}`;
  if (!rawBase.trim()) {
    return { host: 'unknown', path: fallbackPath };
  }
  try {
    const parsed = new URL(rawBase);
    const normalizedBasePath = parsed.pathname.replace(/\/$/, '');
    const pathPrefix = normalizedBasePath.toLowerCase().includes('/rest/api/3')
      ? normalizedBasePath
      : `${normalizedBasePath}${DEFAULT_JIRA_API_PATH_PREFIX}`;
    return {
      host: parsed.host,
      path: `${pathPrefix}/${issueKey}`
    };
  } catch {
    return { host: 'invalid_jira_base_url', path: fallbackPath };
  }
}

function normalizeJiraKey(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const match = value.match(/[A-Z][A-Z0-9_]*-\d+/i);
  if (!match?.[0]) {
    return undefined;
  }
  const candidate = match[0].toUpperCase();
  return JIRA_KEY_PATTERN.test(candidate) ? candidate : undefined;
}

async function detectJiraIssueKeyWithIntent(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    text: string;
  }
) {
  const { settings } = await resolveSlackIntentScopeConfig(env, input.tenantId, {
    channelId: input.channelId
  });
  const parsed = await parseSlackIntentWithLlm(env, {
    text: input.text,
    settings,
    priorTurns: 0
  });
  if (parsed.intent !== 'fix_jira') {
    return undefined;
  }
  return normalizeJiraKey(parsed.jiraKey);
}

async function detectReviewCommandWithIntent(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    text: string;
  }
): Promise<SlackReviewFastPathInput | undefined> {
  const { settings } = await resolveSlackIntentScopeConfig(env, input.tenantId, {
    channelId: input.channelId
  });
  const apiKey = (env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY?.trim();
  if (!apiKey || !settings.intentEnabled) {
    return undefined;
  }
  const schema = {
    name: 'slack_review_intent_parser',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        isReview: { type: 'boolean' },
        reviewNumber: { type: 'integer', minimum: 1 },
        reviewUrl: { type: 'string' },
        providerHint: { type: 'string', enum: ['github', 'gitlab', 'unknown'] }
      },
      required: ['isReview', 'reviewNumber', 'reviewUrl', 'providerHint']
    },
    strict: true
  } as const;
  const models = Array.from(new Set([settings.intentModel, ...REVIEW_INTENT_FALLBACK_MODELS])).filter(Boolean);
  const text = input.text.trim();
  console.info(JSON.stringify({
    event: 'slack_review_intent',
    phase: 'start',
    tenantId: input.tenantId,
    channelId: input.channelId,
    modelCount: models.length,
    textPreview: truncateForText(toSingleLine(text), 180)
  }));
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    try {
      console.info(JSON.stringify({
        event: 'slack_review_intent',
        phase: 'request',
        tenantId: input.tenantId,
        channelId: input.channelId,
        model,
        attempt: index + 1
      }));
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: [
                'Classify whether the user requests a code review run.',
                'If review is requested, extract the MR/PR number and optional URL.',
                'Return strict JSON only.'
              ].join(' ')
            },
            {
              role: 'user',
              content: `text: ${text}`
            }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: schema
          },
          temperature: 0,
          reasoning_effort: settings.intentReasoningEffort
        })
      });
      if (!response.ok) {
        console.warn(JSON.stringify({
          event: 'slack_review_intent',
          phase: 'response_not_ok',
          tenantId: input.tenantId,
          channelId: input.channelId,
          model,
          attempt: index + 1,
          status: response.status
        }));
        continue;
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = payload.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) {
        console.warn(JSON.stringify({
          event: 'slack_review_intent',
          phase: 'response_empty',
          tenantId: input.tenantId,
          channelId: input.channelId,
          model,
          attempt: index + 1
        }));
        continue;
      }
      const parsed = JSON.parse(content) as LlmReviewIntent;
      if (!parsed.isReview || !Number.isFinite(parsed.reviewNumber) || Number(parsed.reviewNumber) < 1) {
        console.info(JSON.stringify({
          event: 'slack_review_intent',
          phase: 'classified_not_review',
          tenantId: input.tenantId,
          channelId: input.channelId,
          model,
          attempt: index + 1
        }));
        return undefined;
      }
      const providerHint = parsed.providerHint === 'github' || parsed.providerHint === 'gitlab'
        ? parsed.providerHint
        : undefined;
      console.info(JSON.stringify({
        event: 'slack_review_intent',
        phase: 'classified_review',
        tenantId: input.tenantId,
        channelId: input.channelId,
        model,
        attempt: index + 1,
        reviewNumber: Math.trunc(Number(parsed.reviewNumber)),
        hasReviewUrl: Boolean(typeof parsed.reviewUrl === 'string' && parsed.reviewUrl.trim()),
        providerHint: providerHint ?? null
      }));
      return {
        reviewNumber: Math.trunc(Number(parsed.reviewNumber)),
        reviewUrl: typeof parsed.reviewUrl === 'string' && parsed.reviewUrl.trim() ? parsed.reviewUrl.trim() : undefined,
        providerHint
      };
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'slack_review_intent',
        phase: 'request_failed',
        tenantId: input.tenantId,
        channelId: input.channelId,
        model,
        attempt: index + 1,
        error: sanitizeErrorMessageForLog(toReadableErrorMessage(error))
      }));
      continue;
    }
  }
  console.info(JSON.stringify({
    event: 'slack_review_intent',
    phase: 'fallback_none',
    tenantId: input.tenantId,
    channelId: input.channelId
  }));
  return undefined;
}

function logSlackCommandLifecycle(input: {
  checkpoint: SlackLifecycleCheckpoint;
  tenantId: string;
  channelId: string;
  issueKey?: string;
  threadTs?: string;
  dedupeKey?: string;
  deduped?: boolean;
  taskId?: string;
  runId?: string;
  jiraHost?: string;
  jiraPath?: string;
  jiraFailureCategory?: string;
  jiraStatus?: number;
  message?: string;
}) {
  console.info(JSON.stringify({
    event: 'slack_command_lifecycle',
    checkpoint: input.checkpoint,
    tenant_id: input.tenantId,
    channel_id: input.channelId,
    thread_ts: input.threadTs ?? null,
    issue_key: input.issueKey ?? null,
    dedupe_key: input.dedupeKey ?? null,
    deduped: input.deduped ?? null,
    task_id: input.taskId ?? null,
    run_id: input.runId ?? null,
    jira_host: input.jiraHost ?? null,
    jira_path: input.jiraPath ?? null,
    jira_failure_category: input.jiraFailureCategory ?? null,
    jira_status: input.jiraStatus ?? null,
    message: input.message ? sanitizeErrorMessageForLog(input.message) : null
  }));
}

function logSlackMentionIngestion(input: {
  checkpoint:
    | 'received'
    | 'normalized'
    | 'ignored'
    | 'deduped'
    | 'invalid_review_syntax'
    | 'review_detected'
    | 'review_flow_started'
    | 'review_flow_failed'
    | 'review_repo_error'
    | 'review_repo_disambiguation'
    | 'review_repo_missing'
    | 'review_repo_candidates'
    | 'review_reply_resolved'
    | 'review_reply_invalid'
    | 'review_started'
    | 'intent_flow_started';
  tenantId?: string;
  channelId?: string;
  threadTs?: string;
  eventTs?: string;
  userId?: string;
  eventType?: string;
  channelType?: string;
  rawText?: string;
  normalizedText?: string;
  reviewNumber?: number;
  reviewUrl?: string;
  reviewProviderHint?: 'github' | 'gitlab';
  dedupeKey?: string;
  deduped?: boolean;
  repoId?: string;
  runId?: string;
  taskId?: string;
  choiceCount?: number;
  error?: unknown;
  message?: string;
}) {
  const preview = (value?: string) => {
    const singleLine = toSingleLine(value);
    return singleLine ? truncateForText(singleLine, MAX_LOG_MESSAGE_CHARS) : null;
  };
  console.info(JSON.stringify({
    event: 'slack_mention_ingestion',
    checkpoint: input.checkpoint,
    tenant_id: input.tenantId ?? null,
    channel_id: input.channelId ?? null,
    thread_ts: input.threadTs ?? null,
    event_ts: input.eventTs ?? null,
    user_id: input.userId ?? null,
    event_type: input.eventType ?? null,
    channel_type: input.channelType ?? null,
    raw_text_preview: preview(input.rawText),
    normalized_text_preview: preview(input.normalizedText),
    review_number: input.reviewNumber ?? null,
    review_url: input.reviewUrl ?? null,
    review_provider_hint: input.reviewProviderHint ?? null,
    dedupe_key: input.dedupeKey ?? null,
    deduped: input.deduped ?? null,
    repo_id: input.repoId ?? null,
    task_id: input.taskId ?? null,
    run_id: input.runId ?? null,
    choice_count: input.choiceCount ?? null,
    message: input.message ? sanitizeErrorMessageForLog(input.message) : null,
    error: input.error ? sanitizeErrorMessageForLog(toReadableErrorMessage(input.error)) : null
  }));
}

function formatSlackThreadLink(channelId: string, threadTs: string) {
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}&message_ts=${encodeURIComponent(threadTs)}`;
}

function normalizeMultilineText(value: string | undefined) {
  return (value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function toSingleLine(value: string | undefined) {
  return normalizeMultilineText(value).replace(/\s+/g, ' ').trim();
}

function truncateForText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stripLeadingSlackMention(text: string): string {
  return text.replace(/^(?:\s*<@[^>]+>\s*)+/, '').trim();
}

function normalizeKanvyInvocationText(rawText: string, input: { eventType?: string; channelType?: string }): string | undefined {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return undefined;
  }
  const mentionStripped = stripLeadingSlackMention(trimmed);
  if (mentionStripped !== trimmed) {
    return mentionStripped;
  }
  const inlineMention = /<@[^>]+>/.exec(trimmed);
  if (inlineMention) {
    const afterMention = trimmed.slice(inlineMention.index + inlineMention[0].length).trim();
    if (afterMention) {
      return afterMention;
    }
  }
  if (trimmed.toLowerCase().startsWith('/kanvy')) {
    return trimmed.slice('/kanvy'.length).trim();
  }
  if (input.channelType === 'im' || input.eventType === 'app_mention') {
    return trimmed;
  }
  return undefined;
}

function buildIntentTextWithThreadContext(
  baseText: string,
  messages: Array<{ text: string; botId?: string; ts?: string }>
): string {
  const command = baseText.trim();
  if (!command || messages.length === 0) {
    return command;
  }
  const contextLines = messages
    .filter((message) => !message.botId)
    .map((message) => truncateForText(toSingleLine(message.text), 220))
    .filter(Boolean)
    .slice(-8);
  if (contextLines.length === 0) {
    return command;
  }
  return [
    'thread_context:',
    ...contextLines.map((line) => `- ${line}`),
    'latest_user_message:',
    command
  ].join('\n');
}

function formatTaskPromptMarkdown(input: {
  goal: string;
  details?: string;
  contextLines?: string[];
  acceptanceCriteria?: string[];
}) {
  const goal = normalizeMultilineText(input.goal) || 'Implement the requested change.';
  const details = normalizeMultilineText(input.details);
  const contextLines = (input.contextLines ?? [])
    .map((line) => normalizeMultilineText(line))
    .filter(Boolean);
  const acceptanceCriteria = (input.acceptanceCriteria ?? [])
    .map((item) => toSingleLine(item))
    .filter(Boolean);
  const sections = [
    '## Goal',
    goal
  ];
  if (details) {
    sections.push('', '## Details', details);
  }
  if (contextLines.length > 0) {
    sections.push('', '## Context', ...contextLines.map((line) => `- ${line}`));
  }
  if (acceptanceCriteria.length > 0) {
    sections.push('', '## Acceptance Criteria', ...acceptanceCriteria.map((item) => `- ${item}`));
  }
  return sections.join('\n').trim();
}

function buildSlackTaskSummary(input: {
  repoId: string;
  title: string;
  prompt: string;
  acceptanceCriteria: string[];
  issueKey?: string;
}) {
  const title = truncateForText(toSingleLine(input.title), MAX_TASK_TITLE_CHARS);
  const prompt = truncateForText(toSingleLine(input.prompt), MAX_SLACK_PROMPT_PREVIEW_CHARS);
  const acceptance = (input.acceptanceCriteria.length > 0 ? input.acceptanceCriteria : ['Task is complete and validated in the target repository.'])
    .map((item) => `- ${truncateForText(toSingleLine(item), 200)}`)
    .join('\n');
  return [
    input.issueKey
      ? `I can create this task from *${input.issueKey}*:`
      : 'I can create this task:',
    `*Repo:* \`${input.repoId}\``,
    `*Title:* ${title}`,
    '*Prompt:*',
    `>${prompt}`,
    '*Acceptance:*',
    acceptance,
    'Reply `yes` or 👍 to create it, or send edits in this thread.'
  ].join('\n');
}

function buildTaskPromptFromIssue(issue: IntegrationIssueRef) {
  return formatTaskPromptMarkdown({
    goal: `Fix Jira issue ${issue.issueKey}: ${toSingleLine(issue.title) || issue.issueKey}`,
    details: normalizeMultilineText(issue.body) || 'No Jira description provided.',
    contextLines: [
      `Jira issue: ${issue.issueKey}`,
      ...(issue.url?.trim() ? [`Jira link: ${issue.url.trim()}`] : [])
    ],
    acceptanceCriteria: [`Fix ${issue.issueKey} in the mapped repository.`]
  });
}

function buildTaskPayloadFromIssue(
  issue: IntegrationIssueRef,
  repoId: string,
  model = DEFAULT_TASK_LLM_MODEL
): CreateTaskInput {
  const issueTitle = toSingleLine(issue.title) || issue.issueKey;
  const description = truncateForText(`Jira ${issue.issueKey}: ${issueTitle}`, MAX_TASK_DESCRIPTION_CHARS);
  return {
    repoId,
    title: truncateForText(`[${issue.issueKey}] ${issueTitle}`.trim(), MAX_TASK_TITLE_CHARS),
    description,
    sourceRef: SOURCE_REF,
    taskPrompt: buildTaskPromptFromIssue(issue),
    acceptanceCriteria: [
      `Fix ${issue.issueKey} in the mapped repository.`
    ],
    context: {
      links: issue.url
        ? [{ id: `jira:${issue.issueKey}`, label: `Jira issue ${issue.issueKey}`, url: issue.url }]
        : [],
      notes: `Imported from Jira issue ${issue.issueKey}: ${issue.title}`
    },
    llmAdapter: JIRA_LLM_ADAPTER,
    codexModel: model,
    codexReasoningEffort: JIRA_LLM_REASONING_EFFORT
  };
}

function ensureIssueKeyInTitle(title: string, issueKey: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    return `[${issueKey}]`;
  }
  if (trimmed.toUpperCase().includes(issueKey.toUpperCase())) {
    return trimmed;
  }
  return `[${issueKey}] ${trimmed}`;
}

async function buildTaskPayloadFromIssueWithLlmTransform(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    repoId: string;
    issue: IntegrationIssueRef;
    commandText: string;
    llmModel: CreateTaskInput['codexModel'];
    settings: ReturnType<typeof resolveSlackIntentSettings>;
  }
): Promise<CreateTaskInput> {
  const fallbackPayload = buildTaskPayloadFromIssue(input.issue, input.repoId, input.llmModel);
  console.info(JSON.stringify({
    event: 'slack_jira_transform_started',
    tenantId: input.tenantId,
    channelId: input.channelId,
    issueKey: input.issue.issueKey,
    repoId: input.repoId,
    llmModel: input.llmModel
  }));
  try {
    const parsed = await parseSlackIntentWithLlm(env, {
      text: [
        `user_command: ${input.commandText.trim() || `fix ${input.issue.issueKey}`}`,
        `jira_issue_key: ${input.issue.issueKey}`,
        `jira_issue_title: ${input.issue.title}`,
        `jira_issue_body: ${input.issue.body}`,
        'Create a concrete implementation task from this Jira issue.'
      ].join('\n'),
      settings: input.settings,
      priorTurns: 0,
      availableRepos: [input.repoId]
    });
    if (parsed.intent !== 'create_task' || parsed.confidence < JIRA_TASK_TRANSFORM_CONFIDENCE_THRESHOLD) {
      console.info(JSON.stringify({
        event: 'slack_jira_transform_result',
        issueKey: input.issue.issueKey,
        intent: parsed.intent,
        confidence: parsed.confidence,
        usedFallback: true,
        reason: parsed.intent !== 'create_task' ? 'intent_not_create_task' : 'low_confidence'
      }));
      return fallbackPayload;
    }
    const taskPrompt = parsed.taskPrompt?.trim() || fallbackPayload.taskPrompt;
    const taskTitle = truncateForText(
      ensureIssueKeyInTitle(parsed.taskTitle?.trim() || fallbackPayload.title, input.issue.issueKey),
      MAX_TASK_TITLE_CHARS
    );
    const acceptanceCriteria = parsed.acceptanceCriteria.length > 0
      ? parsed.acceptanceCriteria
      : fallbackPayload.acceptanceCriteria;
    const normalizedPrompt = formatTaskPromptMarkdown({
      goal: taskTitle,
      details: taskPrompt,
      contextLines: [
        `Jira issue: ${input.issue.issueKey}`,
        ...(input.issue.url?.trim() ? [`Jira link: ${input.issue.url.trim()}`] : [])
      ],
      acceptanceCriteria
    });
    console.info(JSON.stringify({
      event: 'slack_jira_transform_result',
      issueKey: input.issue.issueKey,
      intent: parsed.intent,
      confidence: parsed.confidence,
      usedFallback: false,
      acceptanceCount: acceptanceCriteria.length
    }));
    return {
      ...fallbackPayload,
      title: taskTitle,
      description: truncateForText(toSingleLine(taskTitle), MAX_TASK_DESCRIPTION_CHARS),
      taskPrompt: normalizedPrompt,
      acceptanceCriteria
    };
  } catch {
    console.info(JSON.stringify({
      event: 'slack_jira_transform_result',
      issueKey: input.issue.issueKey,
      usedFallback: true,
      reason: 'transform_exception'
    }));
    return fallbackPayload;
  }
}

async function queueJiraConfirmation(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    issue: IntegrationIssueRef;
    payload: CreateTaskInput;
    responseUrl?: string;
  }
) {
  const title = input.payload.title.trim();
  const prompt = input.payload.taskPrompt.trim();
  const acceptanceCriteria = input.payload.acceptanceCriteria.length > 0
    ? input.payload.acceptanceCriteria
    : ['Task is complete and validated in the target repository.'];

  console.info(JSON.stringify({
    event: 'slack_jira_confirmation_prepare',
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    issueKey: input.issue.issueKey,
    repoId: input.payload.repoId,
    titlePreview: title.slice(0, 120)
  }));

  await tenantAuthDb.upsertSlackIntakeSession(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    status: 'active',
    turnCount: 0,
    data: {
      intent: 'create_task',
      confidence: 1,
      jiraKey: input.issue.issueKey,
      repoId: input.payload.repoId,
      taskTitle: title,
      taskPrompt: prompt,
      acceptanceCriteria,
      missingFields: [],
      pendingConfirmation: {
        repoId: input.payload.repoId,
        title,
        prompt,
        acceptanceCriteria
      }
    }
  });
  console.info(JSON.stringify({
    event: 'slack_jira_confirmation_session_saved',
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    issueKey: input.issue.issueKey
  }));

  const summary = [
    buildSlackTaskSummary({
      repoId: input.payload.repoId,
      title,
      prompt,
      acceptanceCriteria,
      issueKey: input.issue.issueKey
    })
  ].join('\n');

  const delivered = await postThreadPrompt(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: summary
  });
  console.info(JSON.stringify({
    event: 'slack_jira_confirmation_post',
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    issueKey: input.issue.issueKey,
    delivered
  }));
  if (!delivered && input.responseUrl) {
    await postSlackResponse(input.responseUrl, {
      response_type: 'ephemeral',
      text: 'I prepared a Jira-based task summary, but failed to post it in-thread. Please retry in this thread.'
    });
  }
}

function buildTaskPayloadFromIntent(input: {
  repoId: string;
  title: string;
  prompt: string;
  acceptanceCriteria: string[];
  model: CreateTaskInput['codexModel'];
}): CreateTaskInput {
  const normalizedTitle = truncateForText(toSingleLine(input.title) || 'Slack intake task', MAX_TASK_TITLE_CHARS);
  const normalizedPrompt = formatTaskPromptMarkdown({
    goal: normalizedTitle,
    details: input.prompt,
    contextLines: ['Source: Slack /kanvy intake'],
    acceptanceCriteria: input.acceptanceCriteria
  });
  return {
    repoId: input.repoId,
    title: normalizedTitle,
    description: truncateForText(toSingleLine(input.prompt), MAX_TASK_DESCRIPTION_CHARS),
    sourceRef: SOURCE_REF,
    taskPrompt: normalizedPrompt,
    acceptanceCriteria: input.acceptanceCriteria,
    context: {
      links: [],
      notes: 'Created from Slack /kanvy intent intake.'
    },
    llmAdapter: JIRA_LLM_ADAPTER,
    codexModel: input.model,
    codexReasoningEffort: 'medium'
  };
}

function resolveReviewProviderFromRepo(repo: Pick<Repo, 'scmProvider' | 'repoId'>): 'github' | 'gitlab' | undefined {
  return repo.scmProvider === 'github' || repo.scmProvider === 'gitlab' ? repo.scmProvider : undefined;
}

function buildReviewSourceRef(reviewProvider: 'github' | 'gitlab', reviewNumber: number) {
  return reviewProvider === 'github'
    ? `pull/${reviewNumber}/head`
    : `refs/merge-requests/${reviewNumber}/head`;
}

function buildReviewCanonicalUrl(
  reviewProvider: 'github' | 'gitlab',
  host: string,
  projectPath: string,
  reviewNumber: number
) {
  const origin = `https://${host}`;
  return reviewProvider === 'github'
    ? `${origin}/${projectPath}/pull/${reviewNumber}`
    : `${origin}/${projectPath}/-/merge_requests/${reviewNumber}`;
}

function buildReviewTaskPayload(input: {
  repoId: string;
  sourceRef: string;
  reviewProvider: 'github' | 'gitlab';
  reviewNumber: number;
  reviewUrl?: string;
  model: CreateTaskInput['codexModel'];
}): CreateTaskInput {
  const reviewLabel = input.reviewProvider === 'github'
    ? `PR #${input.reviewNumber}`
    : `MR !${input.reviewNumber}`;
  const reviewGoal = `Review existing ${reviewLabel} and post actionable findings only.`;
  return {
    repoId: input.repoId,
    title: truncateForText(`[Review] ${reviewLabel}`.trim(), MAX_TASK_TITLE_CHARS),
    description: truncateForText(toSingleLine(reviewGoal), MAX_TASK_DESCRIPTION_CHARS),
    sourceRef: input.sourceRef,
    taskPrompt: formatTaskPromptMarkdown({
      goal: reviewGoal,
      details: [
        `Run review-only mode against ${reviewLabel}.`,
        'Do not implement or modify code; only review and publish findings.'
      ].join(' '),
      contextLines: [
        `Review provider: ${input.reviewProvider}`,
        `Review number: ${input.reviewNumber}`,
        ...(input.reviewUrl ? [`Review URL: ${input.reviewUrl}`] : [])
      ],
      acceptanceCriteria: [
        'Review findings are generated for the target review.',
        'Findings are posted to the review provider.'
      ]
    }),
    acceptanceCriteria: [
      'Review findings are generated for the target review.',
      'Findings are posted to the review provider.'
    ],
    context: {
      links: input.reviewUrl
        ? [{ id: `${input.reviewProvider}:${input.reviewNumber}`, label: reviewLabel, url: input.reviewUrl }]
        : [],
      notes: `Created from Slack /kanvy review for ${reviewLabel}.`
    },
    autoReviewMode: 'on',
    llmAdapter: JIRA_LLM_ADAPTER,
    codexModel: input.model,
    codexReasoningEffort: 'medium'
  };
}

async function listTenantRepos(env: Env, tenantId: string): Promise<Repo[]> {
  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex?.listRepos) {
    return [];
  }
  try {
    return await boardIndex.listRepos(tenantId) as Repo[];
  } catch {
    return [];
  }
}

function findRepoByReviewUrl(
  repos: Repo[],
  input: Required<Pick<SlackReviewFastPathInput, 'providerHint' | 'repoHostHint' | 'projectPathHint'>> & Pick<SlackReviewFastPathInput, 'reviewNumber'>
) {
  return repos.find((repo) => {
    const provider = resolveReviewProviderFromRepo(repo);
    if (!provider || provider !== input.providerHint) {
      return false;
    }
    return getRepoHost(repo).toLowerCase() === input.repoHostHint.toLowerCase()
      && getRepoProjectPath(repo) === input.projectPathHint;
  });
}

function resolveReviewRepoChoices(repos: Repo[]): ReviewRepoDisambiguationChoice[] {
  return repos
    .map((repo) => {
      const provider = resolveReviewProviderFromRepo(repo);
      if (!provider) {
        return undefined;
      }
      return {
        repoId: repo.repoId,
        label: `${repo.slug} (${repo.repoId})`,
        reviewProvider: provider
      };
    })
    .filter((entry): entry is ReviewRepoDisambiguationChoice => Boolean(entry));
}

function buildRepoCandidateValue(value: {
  tenantId: string;
  taskId: string;
  channelId: string;
  threadTs: string;
  issueKey: string;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
  repoId: string;
}) {
  return JSON.stringify({
    tenantId: value.tenantId,
    taskId: value.taskId,
    channelId: value.channelId,
    threadTs: value.threadTs,
    issueKey: value.issueKey,
    issueTitle: value.issueTitle,
    issueBody: value.issueBody,
    issueUrl: value.issueUrl,
    repoId: value.repoId
  });
}

function buildReviewRepoCandidateValue(value: {
  tenantId: string;
  channelId: string;
  threadTs: string;
  repoId: string;
  reviewNumber: number;
  reviewProvider: 'github' | 'gitlab';
  reviewUrl?: string;
}) {
  return JSON.stringify({
    tenantId: value.tenantId,
    channelId: value.channelId,
    threadTs: value.threadTs,
    repoId: value.repoId,
    reviewNumber: value.reviewNumber,
    reviewProvider: value.reviewProvider,
    reviewUrl: value.reviewUrl
  });
}

async function postSlackResponse(responseUrl: string | undefined, payload: unknown) {
  if (!responseUrl) {
    return;
  }
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    // Slack responses are best-effort from the platform side.
  }
}

function buildDisambiguationResponse(
  issue: IntegrationIssueRef,
  issueProjectKey: string,
  options: RepoDisambiguationChoice[],
  tenantId: string,
  isNoMapping: boolean,
  taskBindingContext: {
    taskId: string;
    channelId: string;
    threadTs: string;
  }
) {
  const actions = options.map((option) => ({
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: option.label },
    action_id: 'repo_disambiguation',
    value: buildRepoCandidateValue({
      tenantId,
      taskId: taskBindingContext.taskId,
      channelId: taskBindingContext.channelId,
      threadTs: taskBindingContext.threadTs,
      issueKey: issue.issueKey,
      issueTitle: issue.title,
      issueBody: issue.body,
      issueUrl: issue.url,
      repoId: option.repoId
    })
  }));

  const warning = isNoMapping
    ? issueProjectKey
      ? `${DISAMBIGUATION_NO_MAPPING_MESSAGE} ${issueProjectKey}.`
      : FALLBACK_DISAMBIGUATION_WARNING
    : issueProjectKey
      ? `${DISAMBIGUATION_MULTIPLE_MAPPINGS_MESSAGE} ${issueProjectKey}.`
      : 'Multiple repository candidates were found.';

  return {
    response_type: 'ephemeral' as const,
    replace_original: false,
    text: `${warning} Pick a repository to continue for ${issue.issueKey}.`,
    blocks: [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: `${warning} Pick a repository to continue for ${issue.issueKey}.` }
      },
      ...(options.length > 0 ? [{
        type: 'actions' as const,
        elements: actions
      }] : [])
    ]
  };
}

function buildNoMappingResponse(issue: IntegrationIssueRef, issueProjectKey: string) {
  return {
    response_type: 'ephemeral' as const,
    text: `${FALLBACK_DISAMBIGUATION_WARNING} ${issueProjectKey ? `No active mapping exists for project ${issueProjectKey}.` : ''} ${issue.issueKey} will not start automatically.`
  };
}

function buildReviewRepoDisambiguationResponse(input: {
  tenantId: string;
  channelId: string;
  threadTs: string;
  reviewNumber: number;
  reviewUrl?: string;
  choices: ReviewRepoDisambiguationChoice[];
}) {
  const reviewLabel = input.reviewUrl?.trim()
    ? input.reviewUrl.trim()
    : `review #${input.reviewNumber}`;
  const actions = input.choices.map((option) => ({
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: option.label },
    action_id: 'review_repo_disambiguation',
    value: buildReviewRepoCandidateValue({
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      repoId: option.repoId,
      reviewNumber: input.reviewNumber,
      reviewProvider: option.reviewProvider,
      reviewUrl: input.reviewUrl
    })
  }));
  return {
    response_type: 'ephemeral' as const,
    replace_original: false,
    text: `Multiple repositories are available for ${reviewLabel}. Pick one to start review-only mode.`,
    callback_id: 'review_disambiguation',
    blocks: [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: `Multiple repositories are available for ${reviewLabel}. Pick one to start review-only mode.` }
      },
      {
        type: 'actions' as const,
        elements: actions
      }
    ]
  };
}

function normalizeLatestReviewRound(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : DEFAULT_REVIEW_ROUND;
}

function toSupportedCodexModel(value: string | undefined): CreateTaskInput['codexModel'] {
  if (value === 'gpt-5.3-codex' || value === 'gpt-5.3-codex-spark' || value === 'gpt-5.1-codex-mini') {
    return value;
  }
  return DEFAULT_TASK_LLM_MODEL;
}

function normalizeJiraIssueFromInteraction(values: {
  issueKey: string;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
}) {
  return {
    issueKey: values.issueKey,
    title: values.issueTitle || values.issueKey,
    body: values.issueBody || 'No description provided.',
    url: values.issueUrl
  };
}

async function markIngressDeliveryIfNew(env: Env, dedupeKey: string) {
  const existing = await env.SECRETS_KV.get(dedupeKey);
  if (existing) {
    return false;
  }
  await env.SECRETS_KV.put(dedupeKey, '1', { expirationTtl: INGRESS_DEDUPE_TTL_SECONDS });
  return true;
}

async function resolveRepoCandidates(
  env: Env,
  tenantId: string,
  issueProjectKey: string,
  mappings: Array<{ repoId: string }>
): Promise<RepoDisambiguationChoice[]> {
  if (mappings.length > 0) {
    return mappings.map((entry) => ({ repoId: entry.repoId, label: entry.repoId }));
  }
  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex) {
    return [];
  }
  try {
    const repos = await boardIndex.listRepos(tenantId);
    return repos
      .filter((repo) => repo.repoId)
      .map((repo) => ({ repoId: repo.repoId, label: `${repo.slug} (${repo.repoId})` }));
  } catch {
    return [];
  }
}

async function resolveSlackIntentScopeConfig(
  env: Env,
  tenantId: string,
  scope: { repoId?: string; channelId: string }
) {
  const configs = await tenantAuthDb.listIntegrationConfigs(env, tenantId, {
    pluginKind: 'slack',
    enabledOnly: true
  });
  return {
    config: resolveIntegrationConfig(configs, {
      tenantId,
      pluginKind: 'slack',
      repoId: scope.repoId,
      channelId: scope.channelId
    }),
    settings: resolveSlackIntentSettings(configs, {
      tenantId,
      repoId: scope.repoId,
      channelId: scope.channelId
    })
  };
}

function isSessionExpired(lastActivityAt: string) {
  const parsed = Date.parse(lastActivityAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return Date.now() - parsed > SESSION_EXPIRY_MS;
}

function normalizeIntentMissingFields(fields: string[], repoResolved: boolean) {
  if (!repoResolved && !fields.includes('repo')) {
    return [...fields, 'repo'];
  }
  return fields;
}

function normalizeRepoChoicesFromSession(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.repoChoices)) {
    return [];
  }
  return record.repoChoices
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
}

function resolveRepoFromNumberReply(text: string, choices: string[]): string | undefined {
  const match = /^\s*(\d+)\s*$/.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index) || index < 1 || index > choices.length) {
    return undefined;
  }
  return choices[index - 1];
}

function rankRepoChoicesByHint(
  choices: Array<{ repoId: string; haystack: string }>,
  rawHint: string
): Array<{ repoId: string; score: number }> {
  const hint = rawHint
    .toLowerCase()
    .replace(/\brepo\b/g, ' ')
    .replace(/[^a-z0-9/_-]+/g, ' ')
    .trim();
  if (!hint) {
    return [];
  }
  const tokens = hint.split(/\s+/).filter(Boolean);
  const scored = choices
    .map((choice) => {
      const lower = choice.haystack.toLowerCase();
      let score = 0;
      if (lower === hint) score += 1000;
      if (lower.includes(hint)) score += 400;
      for (const token of tokens) {
        if (token.length >= 2 && lower.includes(token)) {
          score += 100;
        }
      }
      return { repoId: choice.repoId, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored;
}

function extractRepoHintFromText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const explicit = /repo\s*[:=]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(trimmed);
  if (explicit?.[1]) {
    return explicit[1].trim();
  }
  const inferred = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/.exec(trimmed);
  return inferred?.[1]?.trim();
}

function isLikelyRepoOnlyText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const stripped = normalized
    .replace(/^repo\s*[:=]\s*/i, '')
    .replace(/[().,\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(stripped);
}

function deriveTaskTitleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Slack intake task';
  }
  const sentence = compact.split(/[.!?]/)[0]?.trim() || compact;
  return sentence.length <= 80 ? sentence : `${sentence.slice(0, 77).trimEnd()}...`;
}

function isAffirmativeConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const emojiAliases = new Set([':+1:', ':thumbsup:', '👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '+1']);
  if (emojiAliases.has(normalized)) {
    return true;
  }
  return normalized === 'yes'
    || normalized === 'y'
    || normalized === 'confirm'
    || normalized === 'go'
    || normalized === 'go ahead'
    || normalized === 'create'
    || normalized === 'create it'
    || normalized === 'ship it';
}

function normalizePendingConfirmation(data: unknown): {
  repoId: string;
  title: string;
  prompt: string;
  acceptanceCriteria: string[];
} | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const root = data as Record<string, unknown>;
  const pending = root.pendingConfirmation;
  if (!pending || typeof pending !== 'object') {
    return undefined;
  }
  const record = pending as Record<string, unknown>;
  const repoId = typeof record.repoId === 'string' && record.repoId.trim() ? record.repoId.trim() : undefined;
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined;
  const prompt = typeof record.prompt === 'string' && record.prompt.trim() ? record.prompt.trim() : undefined;
  if (!repoId || !title || !prompt) {
    return undefined;
  }
  const acceptanceCriteria = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
  return { repoId, title, prompt, acceptanceCriteria };
}

function normalizePendingReviewSelection(data: unknown): {
  reviewNumber: number;
  reviewUrl?: string;
  reviewProviderHint?: 'github' | 'gitlab';
  choices: string[];
} | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const root = data as Record<string, unknown>;
  const pending = root.pendingReviewSelection;
  if (!pending || typeof pending !== 'object') {
    return undefined;
  }
  const record = pending as Record<string, unknown>;
  const reviewNumber = typeof record.reviewNumber === 'number' && Number.isFinite(record.reviewNumber)
    ? Math.trunc(record.reviewNumber)
    : undefined;
  const reviewUrl = typeof record.reviewUrl === 'string' && record.reviewUrl.trim()
    ? record.reviewUrl.trim()
    : undefined;
  const reviewProviderHint = record.reviewProviderHint === 'github' || record.reviewProviderHint === 'gitlab'
    ? record.reviewProviderHint
    : undefined;
  const choices = Array.isArray(record.choices)
    ? record.choices
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  if (!reviewNumber || choices.length === 0) {
    return undefined;
  }
  return { reviewNumber, reviewUrl, reviewProviderHint, choices };
}

function resolveRepoFromReply(text: string, choices: string[]): string | undefined {
  const byNumber = resolveRepoFromNumberReply(text, choices);
  if (byNumber) {
    return byNumber;
  }
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  return choices.find((choice) => choice === normalized);
}

function normalizeSessionIntentData(data: unknown): Partial<SlackIntentParseResult> {
  if (!data || typeof data !== 'object') {
    return {};
  }
  const record = data as Record<string, unknown>;
  const readString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const readArray = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
  const intent = record.intent === 'fix_jira' || record.intent === 'create_task' || record.intent === 'unknown'
    ? record.intent
    : undefined;
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : undefined;
  return {
    ...(intent ? { intent } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    jiraKey: readString(record.jiraKey),
    repoHint: readString(record.repoHint),
    repoId: readString(record.repoId),
    taskTitle: readString(record.taskTitle),
    taskPrompt: readString(record.taskPrompt),
    acceptanceCriteria: readArray(record.acceptanceCriteria),
    missingFields: readArray(record.missingFields),
    clarifyingQuestion: readString(record.clarifyingQuestion)
  };
}

function buildIntentParseInputText(currentText: string, previous: Partial<SlackIntentParseResult>) {
  const current = currentText.trim();
  const normalizePromptForContext = (value: string | undefined) => {
    if (!value) {
      return undefined;
    }
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    if (normalized.includes('prior_context:') || normalized.includes('latest_user_message:')) {
      return undefined;
    }
    return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
  };
  const priorTaskPrompt = normalizePromptForContext(previous.taskPrompt);
  if (!previous.taskPrompt && !previous.taskTitle && !previous.repoHint && !previous.repoId) {
    return current;
  }
  const priorLines = [
    previous.taskTitle ? `taskTitle=${previous.taskTitle}` : '',
    priorTaskPrompt ? `taskPrompt=${priorTaskPrompt}` : '',
    previous.repoId ? `repoId=${previous.repoId}` : '',
    previous.repoHint ? `repoHint=${previous.repoHint}` : '',
    previous.acceptanceCriteria && previous.acceptanceCriteria.length > 0
      ? `acceptanceCriteria=${previous.acceptanceCriteria.join(' | ')}`
      : ''
  ].filter(Boolean);

  return [
    'prior_context:',
    ...(priorLines.length > 0 ? priorLines : ['none']),
    'latest_user_message:',
    current
  ].join('\n');
}

function mergeIntentWithSession(
  parsed: SlackIntentParseResult,
  previous: Partial<SlackIntentParseResult>,
  latestText: string
): SlackIntentParseResult {
  const sanitizeTaskPrompt = (value: string | undefined): string | undefined => {
    if (!value) {
      return undefined;
    }
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    if (normalized.includes('prior_context:') || normalized.includes('latest_user_message:')) {
      return undefined;
    }
    return normalized;
  };
  const derivedRepoHint = extractRepoHintFromText(latestText);
  const mergedAcceptanceCriteria = parsed.acceptanceCriteria.length > 0
    ? parsed.acceptanceCriteria
    : previous.acceptanceCriteria && previous.acceptanceCriteria.length > 0
      ? previous.acceptanceCriteria
      : [];

  const merged: SlackIntentParseResult = {
    intent: parsed.intent !== 'unknown'
      ? parsed.intent
      : previous.intent ?? 'unknown',
    confidence: parsed.confidence > 0
      ? parsed.confidence
      : previous.confidence ?? 0,
    jiraKey: parsed.jiraKey ?? previous.jiraKey,
    repoHint: parsed.repoHint ?? derivedRepoHint ?? previous.repoHint,
    repoId: parsed.repoId ?? previous.repoId,
    taskTitle: parsed.taskTitle ?? previous.taskTitle,
    taskPrompt: sanitizeTaskPrompt(parsed.taskPrompt) ?? sanitizeTaskPrompt(previous.taskPrompt),
    acceptanceCriteria: mergedAcceptanceCriteria,
    missingFields: parsed.missingFields,
    clarifyingQuestion: parsed.clarifyingQuestion ?? previous.clarifyingQuestion
  };

  const resolvedMissing = new Set(merged.missingFields);
  if (merged.repoId || merged.repoHint) {
    resolvedMissing.delete('repo');
  }
  if (merged.taskPrompt) {
    resolvedMissing.delete('taskPrompt');
    resolvedMissing.delete('acceptanceCriteria');
  }
  if (merged.taskTitle) {
    resolvedMissing.delete('title');
    resolvedMissing.delete('taskTitle');
  }
  merged.missingFields = Array.from(resolvedMissing);
  return merged;
}

async function resolveRepoIdForIntent(
  env: Env,
  tenantId: string,
  channelId: string,
  parsed: SlackIntentParseResult
) {
  if (parsed.repoId?.trim()) {
    return { repoId: parsed.repoId.trim(), ambiguous: false, choices: [] as string[] };
  }
  const explicitRepoHint = parsed.repoHint?.trim()
    ? (extractRepoHintFromText(parsed.repoHint) ?? parsed.repoHint.trim())
    : undefined;

  const { settings } = await resolveSlackIntentScopeConfig(env, tenantId, {
    channelId,
    repoId: undefined
  });
  if (settings.defaultRepoId?.trim()) {
    return { repoId: settings.defaultRepoId.trim(), ambiguous: false, choices: [] as string[] };
  }

  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex) {
    if (explicitRepoHint?.includes('/')) {
      return { repoId: explicitRepoHint, ambiguous: false, choices: [] as string[] };
    }
    return { repoId: undefined, ambiguous: false, choices: [] as string[] };
  }
  try {
    const repos = await boardIndex.listRepos(tenantId);
    if (repos.length === 0 && explicitRepoHint?.includes('/')) {
      return { repoId: explicitRepoHint, ambiguous: false, choices: [] as string[] };
    }
    if (repos.length === 1 && repos[0]?.repoId) {
      return { repoId: repos[0].repoId, ambiguous: false, choices: [] as string[] };
    }
    if (repos.length > 1) {
      const choiceObjects = repos
        .filter((repo) => typeof repo.repoId === 'string' && repo.repoId.trim().length > 0)
        .map((repo) => ({
          repoId: repo.repoId.trim(),
          slug: typeof repo.slug === 'string' ? repo.slug.trim() : ''
        }));
      const choices = choiceObjects.map((entry) => entry.repoId);
      if (parsed.repoHint?.trim()) {
        const hint = parsed.repoHint.trim().toLowerCase();
        const exact = choiceObjects.find((entry) => entry.repoId.toLowerCase() === hint || entry.slug.toLowerCase() === hint);
        if (exact) {
          return { repoId: exact.repoId, ambiguous: false, choices };
        }
        const ranked = rankRepoChoicesByHint(
          choiceObjects.map((entry) => ({
            repoId: entry.repoId,
            haystack: `${entry.repoId} ${entry.slug}`.trim()
          })),
          parsed.repoHint
        );
        if (ranked.length === 1) {
          return { repoId: ranked[0]?.repoId, ambiguous: false, choices };
        }
        if (ranked.length > 1) {
          const best = ranked[0]!;
          const second = ranked[1]!;
          if (best.score >= second.score + 200) {
            return { repoId: best.repoId, ambiguous: false, choices };
          }
          return { repoId: undefined, ambiguous: true, choices: ranked.slice(0, 9).map((entry) => entry.repoId) };
        }
      }
      return { repoId: undefined, ambiguous: true, choices };
    }
  } catch {
    // Best effort.
  }
  if (explicitRepoHint?.includes('/')) {
    return { repoId: explicitRepoHint, ambiguous: false, choices: [] as string[] };
  }
  return { repoId: undefined, ambiguous: false, choices: [] as string[] };
}

async function listAvailableRepoIdsForTenant(env: Env, tenantId: string): Promise<string[]> {
  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex) {
    return [];
  }
  try {
    const repos = await boardIndex.listRepos(tenantId);
    const values = repos.flatMap((repo) => {
      const repoId = typeof repo.repoId === 'string' && repo.repoId.trim() ? repo.repoId.trim() : undefined;
      const slug = typeof repo.slug === 'string' && repo.slug.trim() ? repo.slug.trim() : undefined;
      return [repoId, slug].filter((entry): entry is string => Boolean(entry));
    });
    return Array.from(new Set(values));
  } catch {
    return [];
  }
}

async function resolveRepoIdForRun(env: Env, runId: string): Promise<string | undefined> {
  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex) {
    return undefined;
  }
  return boardIndex.findRunRepoId
    ? boardIndex.findRunRepoId(runId)
    : undefined;
}

async function resolvePreferredRepoFromChannelContext(
  env: Env,
  tenantId: string,
  channelId: string
): Promise<string | undefined> {
  const bindings = await tenantAuthDb.listSlackThreadBindings(env, tenantId, { channelId });
  for (const binding of bindings) {
    const runId = binding.currentRunId?.trim();
    if (!runId) {
      continue;
    }
    const repoId = await resolveRepoIdForRun(env, runId);
    if (repoId?.trim()) {
      console.info(JSON.stringify({
        event: 'slack_jira_repo_selected',
        tenantId,
        channelId,
        threadTs: binding.threadTs,
        repoId: repoId.trim(),
        source: 'channel_context'
      }));
      return repoId.trim();
    }
  }
  return undefined;
}

async function resolvePreferredRepoFromThreadContext(
  env: Env,
  tenantId: string,
  channelId: string,
  threadTs: string
): Promise<string | undefined> {
  const bindings = await tenantAuthDb.listSlackThreadBindings(env, tenantId, { channelId });
  for (const binding of bindings) {
    if (binding.threadTs !== threadTs) {
      continue;
    }
    const runId = binding.currentRunId?.trim();
    if (!runId) {
      continue;
    }
    const repoId = await resolveRepoIdForRun(env, runId);
    if (repoId?.trim()) {
      return repoId.trim();
    }
  }

  const session = await tenantAuthDb.getSlackIntakeSession(env, tenantId, channelId, threadTs);
  if (!session) {
    return undefined;
  }

  const pending = normalizePendingConfirmation(session.pendingConfirmation);
  if (pending?.repoId?.trim()) {
    return pending.repoId.trim();
  }

  const intentData = normalizeSessionIntentData(session.intentData);
  if (intentData.repoId?.trim()) {
    return intentData.repoId.trim();
  }

  return undefined;
}

function scoreRepoHintMatch(repo: Repo, text: string): number {
  const haystack = text.toLowerCase();
  let score = 0;
  const repoId = repo.repoId?.trim().toLowerCase();
  const slug = repo.slug?.trim().toLowerCase();
  const host = getRepoHost(repo)?.trim().toLowerCase();
  const projectPath = getRepoProjectPath(repo)?.trim().toLowerCase();
  if (repoId && haystack.includes(repoId)) {
    score += 900;
  }
  if (slug && haystack.includes(slug)) {
    score += 700;
  }
  if (host && projectPath && haystack.includes(`${host}/${projectPath}`)) {
    score += 1000;
  }
  if (projectPath && haystack.includes(projectPath)) {
    score += 450;
  }
  if (host && haystack.includes(host)) {
    score += 120;
  }
  return score;
}

async function resolvePreferredRepoFromThreadMessages(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    reviewRepos: Repo[];
    review: SlackReviewFastPathInput;
  }
): Promise<string | undefined> {
  try {
    const messages = await fetchSlackThreadMessages(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      limit: 20
    });
    if (!messages.length) {
      return undefined;
    }
    const ranked = input.reviewRepos
      .map((repo) => {
        const score = messages.reduce((total, message) => total + scoreRepoHintMatch(repo, message.text ?? ''), 0);
        return { repoId: repo.repoId, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) {
      return undefined;
    }
    const best = ranked[0]!;
    const second = ranked[1];
    if (!second || best.score >= second.score + 200) {
      return best.repoId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function startRunForTask(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  tenantId: string,
  repoId: string,
  taskPayload: CreateTaskInput
): Promise<RunKickoff> {
  const repoBoard = env.REPO_BOARD.getByName(repoId);
  const task = await repoBoard.createTask(taskPayload);
  const run = await repoBoard.startRun(task.taskId, { tenantId });
  const workflow = await scheduleRunJob(env, executionContextOrNoop(ctx), {
    tenantId,
    repoId,
    taskId: task.taskId,
    runId: run.runId,
    mode: 'full_run'
  });
  await repoBoard.transitionRun(run.runId, {
    workflowInstanceId: workflow.id,
    orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
  });
  await mirrorRunLifecycleMilestone(env, run, 'queued', `${run.runId}:queued`).catch(() => {
    // Slack timeline mirroring is best effort.
  });
  return { taskId: task.taskId, runId: run.runId };
}

async function startReviewRunForTask(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  tenantId: string,
  repoId: string,
  review: ResolvedReviewCommand,
  model: CreateTaskInput['codexModel']
): Promise<RunKickoff> {
  const repoBoard = env.REPO_BOARD.getByName(repoId);
  const task = await repoBoard.createTask(buildReviewTaskPayload({
    repoId,
    sourceRef: review.sourceRef,
    reviewProvider: review.reviewProvider,
    reviewNumber: review.reviewNumber,
    reviewUrl: review.reviewUrl,
    model
  }));
  const run = await repoBoard.startRun(task.taskId, { tenantId });
  await repoBoard.transitionRun(run.runId, {
    status: 'PR_OPEN',
    branchName: review.sourceRef,
    reviewProvider: review.reviewProvider,
    reviewNumber: review.reviewNumber,
    reviewUrl: review.reviewUrl,
    prNumber: review.reviewNumber,
    prUrl: review.reviewUrl
  }, tenantId);
  const workflow = await scheduleRunJob(env, executionContextOrNoop(ctx), {
    tenantId,
    repoId,
    taskId: task.taskId,
    runId: run.runId,
    mode: 'review_only'
  });
  await repoBoard.transitionRun(run.runId, {
    workflowInstanceId: workflow.id,
    orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow',
    appendTimelineNote: `Review-only run queued for ${review.reviewProvider} #${review.reviewNumber}.`
  }, tenantId);
  return { taskId: task.taskId, runId: run.runId };
}

async function syncSlackBindingAfterRunStart(
  env: Env,
  tenantId: string,
  existingTaskId: string,
  binding: {
    taskId: string;
    channelId: string;
    threadTs: string;
    runId: string;
    latestReviewRound: number;
  }
) {
  await tenantAuthDb.deleteSlackThreadBinding(env, tenantId, existingTaskId, binding.channelId).catch(() => {});
  await tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId,
    taskId: binding.taskId,
    channelId: binding.channelId,
    threadTs: binding.threadTs,
    currentRunId: binding.runId,
    latestReviewRound: binding.latestReviewRound
  });
}

async function startSlackApprovedRerun(
  env: Env,
  ctx: ExecutionContext<unknown>,
  tenantId: string,
  interaction: ParsedSlackInteraction
) {
  const currentRunId = interaction.currentRunId?.trim();
  if (!currentRunId) {
    throw badRequest('Missing current run context for rerun approval.');
  }

  const repoId = await resolveRepoIdForRun(env, currentRunId);
  if (!repoId) {
    throw badRequest('Unable to resolve repository for the current run.');
  }

  const repoBoard = env.REPO_BOARD.getByName(repoId);
  const nextReviewRound = normalizeLatestReviewRound(interaction.latestReviewRound) + 1;
  const transition = await repoBoard.transitionRunFromLoopState(currentRunId, 'DECISION_REQUIRED', {
    loopState: 'RERUN_QUEUED'
  }, tenantId);
  if (!transition.transitioned) {
    return;
  }

  const run = await repoBoard.requestRunChanges(
    currentRunId,
    {
      prompt: `Slack approved rerun for review round ${nextReviewRound}.`
    },
    tenantId
  );

  const workflow = await scheduleRunJob(env, executionContextOrNoop(ctx), {
    tenantId,
    repoId,
    taskId: run.taskId,
    runId: run.runId,
    mode: 'full_run'
  });

  await repoBoard.transitionRun(run.runId, {
    loopState: 'RERUN_QUEUED',
    workflowInstanceId: workflow.id,
    orchestrationMode: workflow.id.startsWith('local-alarm-') ? 'local_alarm' : 'workflow'
  });

  await tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId,
    taskId: interaction.taskId,
    channelId: interaction.channelId,
    threadTs: interaction.threadTs,
    currentRunId: run.runId,
    latestReviewRound: nextReviewRound
  });
}

async function pauseSlackRun(
  env: Env,
  tenantId: string,
  interaction: ParsedSlackInteraction,
  repoId: string | undefined
) {
  if (!interaction.currentRunId?.trim() || !repoId) {
    return;
  }
  const repoBoard = env.REPO_BOARD.getByName(repoId);
  await repoBoard.transitionRun(interaction.currentRunId, {
    loopState: 'PAUSED'
  }, tenantId);
}

async function createThreadBindingForSlashCommand(
  env: Env,
  tenantId: string,
  commandIssueKey: string,
  channelId: string,
  threadTs: string
) {
  const taskId = buildTaskIdFromIssue(commandIssueKey);
  await tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId,
    taskId,
    channelId,
    threadTs,
    latestReviewRound: DEFAULT_REVIEW_ROUND
  });
  return taskId;
}

async function resolveTenantAndJiraIssue(env: Env, tenantId: string, issueKey: string): Promise<IntegrationIssueRef> {
  const jira = createJiraIssueSourceIntegrationFromEnv(env, tenantId);
  return jira.fetchIssue(issueKey, tenantId);
}

type ReviewRepoResolution = {
  repo?: Repo;
  choices?: ReviewRepoDisambiguationChoice[];
  errorMessage?: string;
};

async function resolveRepoForReviewCommand(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    threadTs?: string;
    review: SlackReviewFastPathInput;
  }
): Promise<ReviewRepoResolution> {
  const repos = await listTenantRepos(env, input.tenantId);
  const reviewRepos = repos.filter((repo) => Boolean(resolveReviewProviderFromRepo(repo)));
  if (reviewRepos.length === 0) {
    return {
      errorMessage: 'No GitHub or GitLab repositories are configured for this tenant.'
    };
  }

  if (input.review.providerHint && input.review.repoHostHint && input.review.projectPathHint) {
    const matched = findRepoByReviewUrl(reviewRepos, {
      providerHint: input.review.providerHint,
      repoHostHint: input.review.repoHostHint,
      projectPathHint: input.review.projectPathHint,
      reviewNumber: input.review.reviewNumber
    });
    if (!matched) {
      return {
        errorMessage: `No configured repository matches ${input.review.reviewUrl ?? `${input.review.providerHint} review #${input.review.reviewNumber}`}.`
      };
    }
    return { repo: matched };
  }

  const { settings, config } = await resolveSlackIntentScopeConfig(env, input.tenantId, {
    channelId: input.channelId
  });
  const threadContextRepoId = input.threadTs
    ? await resolvePreferredRepoFromThreadContext(env, input.tenantId, input.channelId, input.threadTs)
    : undefined;
  const scopedRepoId = config?.scopeType === 'repo' && config.scopeId?.trim()
    ? config.scopeId.trim()
    : undefined;
  const contextRepoId = await resolvePreferredRepoFromChannelContext(env, input.tenantId, input.channelId);
  const threadMessageRepoId = input.threadTs
    ? await resolvePreferredRepoFromThreadMessages(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      reviewRepos,
      review: input.review
    })
    : undefined;
  logSlackMentionIngestion({
    checkpoint: 'review_repo_candidates',
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    reviewNumber: input.review.reviewNumber,
    reviewUrl: input.review.reviewUrl,
    reviewProviderHint: input.review.providerHint,
    message: `review_repos=${reviewRepos.length}; preferred=[thread:${threadContextRepoId ?? 'none'}, thread_messages:${threadMessageRepoId ?? 'none'}, scope:${scopedRepoId ?? 'none'}, default:${settings.defaultRepoId?.trim() || 'none'}, channel:${contextRepoId ?? 'none'}]`
  });
  const preferredRepoIds = [
    threadContextRepoId,
    threadMessageRepoId,
    scopedRepoId,
    settings.defaultRepoId?.trim(),
    contextRepoId
  ].filter((value): value is string => Boolean(value));
  for (const candidateRepoId of preferredRepoIds) {
    const matched = reviewRepos.find((repo) => repo.repoId === candidateRepoId);
    if (matched) {
      return { repo: matched };
    }
  }

  if (reviewRepos.length === 1) {
    return { repo: reviewRepos[0] };
  }

  return { choices: resolveReviewRepoChoices(reviewRepos) };
}

function resolveReviewCommandForRepo(repo: Repo, review: SlackReviewFastPathInput): ResolvedReviewCommand {
  const reviewProvider = resolveReviewProviderFromRepo(repo);
  if (!reviewProvider) {
    throw badRequest(`Repo ${repo.repoId} is not configured with a GitHub or GitLab SCM provider.`);
  }
  if (review.providerHint && review.providerHint !== reviewProvider) {
    throw badRequest(`Review provider mismatch: command targets ${review.providerHint} but repo ${repo.repoId} is ${reviewProvider}.`);
  }
  const sourceRef = buildReviewSourceRef(reviewProvider, review.reviewNumber);
  return {
    reviewProvider,
    reviewNumber: review.reviewNumber,
    reviewUrl: review.reviewUrl ?? buildReviewCanonicalUrl(reviewProvider, getRepoHost(repo), getRepoProjectPath(repo), review.reviewNumber),
    sourceRef
  };
}

async function processReviewCommandFlow(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    responseUrl?: string;
    review: SlackReviewFastPathInput;
  }
): Promise<RunKickoff | undefined> {
  logSlackMentionIngestion({
    checkpoint: 'review_flow_started',
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    reviewNumber: input.review.reviewNumber,
    reviewUrl: input.review.reviewUrl,
    reviewProviderHint: input.review.providerHint
  });
  const repoResolution = await resolveRepoForReviewCommand(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    review: input.review
  });
  if (repoResolution.errorMessage) {
    logSlackMentionIngestion({
      checkpoint: 'review_repo_error',
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      reviewNumber: input.review.reviewNumber,
      reviewUrl: input.review.reviewUrl,
      reviewProviderHint: input.review.providerHint,
      message: repoResolution.errorMessage
    });
    await postSlackResponse(input.responseUrl, {
      response_type: 'ephemeral',
      text: `${repoResolution.errorMessage} Usage: \`/kanvy review <MR_NUMBER|MR_URL>\`.`
    });
    return undefined;
  }
  if (repoResolution.choices && repoResolution.choices.length > 0) {
    logSlackMentionIngestion({
      checkpoint: 'review_repo_disambiguation',
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      reviewNumber: input.review.reviewNumber,
      reviewUrl: input.review.reviewUrl,
      reviewProviderHint: input.review.providerHint,
      choiceCount: repoResolution.choices.length
    });
    if (input.responseUrl) {
      await postSlackResponse(input.responseUrl, buildReviewRepoDisambiguationResponse({
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        reviewNumber: input.review.reviewNumber,
        reviewUrl: input.review.reviewUrl,
        choices: repoResolution.choices
      }));
    } else {
      const existingSession = await tenantAuthDb.getSlackIntakeSession(env, input.tenantId, input.channelId, input.threadTs);
      await tenantAuthDb.upsertSlackIntakeSession(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        status: 'active',
        turnCount: existingSession?.turnCount ?? 0,
        lastConfidence: existingSession?.lastConfidence,
        data: {
          ...(existingSession?.data ?? {}),
          pendingReviewSelection: {
            reviewNumber: input.review.reviewNumber,
            reviewUrl: input.review.reviewUrl,
            reviewProviderHint: input.review.providerHint,
            choices: repoResolution.choices.map((choice) => choice.repoId)
          }
        }
      });
      const reviewLabel = input.review.reviewUrl?.trim()
        ? input.review.reviewUrl.trim()
        : `review #${input.review.reviewNumber}`;
      await postThreadPrompt(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: [
          `Multiple repositories match ${reviewLabel}.`,
          'Reply with one repo id, then rerun with a full review URL:',
          '`@kanvy review <MR_URL>`',
          'Candidates:',
          ...repoResolution.choices.map((choice, index) => `${index + 1}. ${choice.repoId}`)
        ].join('\n')
      });
    }
    return undefined;
  }
  const repo = repoResolution.repo;
  if (!repo) {
    logSlackMentionIngestion({
      checkpoint: 'review_repo_missing',
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      reviewNumber: input.review.reviewNumber,
      reviewUrl: input.review.reviewUrl,
      reviewProviderHint: input.review.providerHint
    });
    await postSlackResponse(input.responseUrl, {
      response_type: 'ephemeral',
      text: 'Unable to resolve a repository for review command.'
    });
    return undefined;
  }
  const review = resolveReviewCommandForRepo(repo, input.review);
  const started = await startReviewRunForTask(
    env,
    ctx,
    input.tenantId,
    repo.repoId,
    review,
    DEFAULT_TASK_LLM_MODEL
  );
  await tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId: input.tenantId,
    taskId: started.taskId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    currentRunId: started.runId,
    latestReviewRound: DEFAULT_REVIEW_ROUND
  });
  await postThreadPrompt(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: `Started review-only run ${started.runId} for ${review.reviewProvider} #${review.reviewNumber} in ${repo.repoId}.`
  });
  logSlackMentionIngestion({
    checkpoint: 'review_started',
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    reviewNumber: review.reviewNumber,
    reviewUrl: review.reviewUrl,
    reviewProviderHint: review.reviewProvider,
    repoId: repo.repoId,
    taskId: started.taskId,
    runId: started.runId
  });
  return started;
}

async function processJiraIssueFlow(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  tenantId: string,
  issue: IntegrationIssueRef,
  bindings: {
    taskId: string;
    channelId: string;
    threadTs?: string;
    latestReviewRound?: number;
  },
  responseUrl: string | undefined,
  llmModel: CreateTaskInput['codexModel'] = DEFAULT_TASK_LLM_MODEL,
  commandText = `fix ${issue.issueKey}`,
  settings = resolveSlackIntentSettings([], { tenantId, channelId: bindings.channelId }),
  preferredRepoId: string | undefined = undefined
): Promise<RunKickoff | undefined> {
  const issueProjectKey = issueProjectKeyFromIssue(issue.issueKey);
  const mappings = await tenantAuthDb.listJiraProjectRepoMappingsByProject(env, tenantId, issueProjectKey, true);
  console.info(JSON.stringify({
    event: 'slack_jira_mapping_resolved',
    tenantId,
    channelId: bindings.channelId,
    threadTs: bindings.threadTs ?? null,
    issueKey: issue.issueKey,
    issueProjectKey,
    mappingCount: mappings.length
  }));
  if (mappings.length === 0) {
    if (preferredRepoId?.trim()) {
      console.info(JSON.stringify({
        event: 'slack_jira_repo_selected',
        tenantId,
        channelId: bindings.channelId,
        threadTs: bindings.threadTs ?? null,
        issueKey: issue.issueKey,
        repoId: preferredRepoId.trim(),
        source: 'configured_scope'
      }));
      const payload = await buildTaskPayloadFromIssueWithLlmTransform(env, {
        tenantId,
        channelId: bindings.channelId,
        repoId: preferredRepoId.trim(),
        issue,
        commandText,
        llmModel,
        settings
      });
      if (!bindings.threadTs) {
        await postSlackResponse(responseUrl, {
          response_type: 'ephemeral',
          text: `Unable to create a confirmation thread for ${issue.issueKey}. Please retry in a thread.`
        });
        return undefined;
      }
      await queueJiraConfirmation(env, {
        tenantId,
        channelId: bindings.channelId,
        threadTs: bindings.threadTs,
        issue,
        payload,
        responseUrl
      });
      return undefined;
    }
    const candidates = await resolveRepoCandidates(env, tenantId, issueProjectKey, []);
    if (candidates.length === 0) {
      await postSlackResponse(responseUrl, buildNoMappingResponse(issue, issueProjectKey));
      return undefined;
    }
    await postSlackResponse(responseUrl, buildDisambiguationResponse(
      issue,
      issueProjectKey,
      candidates,
      tenantId,
      true,
      { taskId: bindings.taskId, channelId: bindings.channelId, threadTs: bindings.threadTs ?? '' }
    ));
    return undefined;
  }

  const candidates = await resolveRepoCandidates(env, tenantId, issueProjectKey, mappings);
  console.info(JSON.stringify({
    event: 'slack_jira_repo_candidates',
    tenantId,
    channelId: bindings.channelId,
    threadTs: bindings.threadTs ?? null,
    issueKey: issue.issueKey,
    candidateCount: candidates.length
  }));
  if (mappings.length > 1) {
    if (candidates.length === 0) {
      await postSlackResponse(responseUrl, buildNoMappingResponse(issue, issueProjectKey));
      return undefined;
    }
    await postSlackResponse(responseUrl, buildDisambiguationResponse(
      issue,
      issueProjectKey,
      candidates,
      tenantId,
      false,
      { taskId: bindings.taskId, channelId: bindings.channelId, threadTs: bindings.threadTs ?? '' }
    ));
    return undefined;
  }

  if (candidates.length !== 1) {
    await postSlackResponse(responseUrl, buildNoMappingResponse(issue, issueProjectKey));
    return undefined;
  }

  const repoId = candidates[0]!.repoId;
  console.info(JSON.stringify({
    event: 'slack_jira_repo_selected',
    tenantId,
    channelId: bindings.channelId,
    threadTs: bindings.threadTs ?? null,
    issueKey: issue.issueKey,
    repoId
  }));
  const payload = await buildTaskPayloadFromIssueWithLlmTransform(env, {
    tenantId,
    channelId: bindings.channelId,
    repoId,
    issue,
    commandText,
    llmModel,
    settings
  });
  if (!bindings.threadTs) {
    await postSlackResponse(responseUrl, {
      response_type: 'ephemeral',
      text: `Unable to create a confirmation thread for ${issue.issueKey}. Please retry in a thread.`
    });
    return undefined;
  }
  await queueJiraConfirmation(env, {
    tenantId,
    channelId: bindings.channelId,
    threadTs: bindings.threadTs,
    issue,
    payload,
    responseUrl
  });
  return undefined;
}

async function resolveThreadTenantId(env: Env, teamId: string | undefined) {
  const fallbackTenantId = await tenantAuthDb.getPrimaryTenantId(env);
  const resolved = resolveThreadTenant(fallbackTenantId, teamId);
  if (!fallbackTenantId || resolved === fallbackTenantId) {
    return resolved;
  }
  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex) {
    return resolved;
  }
  try {
    const candidateRepos = await boardIndex.listRepos(resolved);
    if (candidateRepos.length > 0) {
      return resolved;
    }
    const fallbackRepos = await boardIndex.listRepos(fallbackTenantId);
    if (fallbackRepos.length > 0) {
      return fallbackTenantId;
    }
  } catch {
    // Best effort: keep the team-scoped tenant resolution when board index is unavailable.
  }
  return resolved;
}

async function updateBindingForAction(
  env: Env,
  tenantId: string,
  interaction: ParsedSlackInteraction
) {
  if (interaction.actionId === 'repo_disambiguation' || interaction.actionId === 'review_repo_disambiguation') {
    return;
  }
  if (!interaction.taskId) {
    throw badRequest('Missing task identifier.');
  }
  const currentRunId = interaction.currentRunId?.trim();
  const latestReviewRound = normalizeLatestReviewRound(interaction.latestReviewRound);

  if (interaction.actionId === 'close') {
    return tenantAuthDb.deleteSlackThreadBinding(env, tenantId, interaction.taskId, interaction.channelId);
  }

  if (interaction.actionId === 'approve_rerun') {
    return;
  }

  return tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId,
    taskId: interaction.taskId,
    channelId: interaction.channelId,
    threadTs: interaction.threadTs,
    currentRunId,
    latestReviewRound
  });
}

async function postThreadPrompt(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    text: string;
  }
) {
  try {
    const result = await postSlackThreadMessage(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: input.text
    });
    if (!result.delivered) {
      console.warn(JSON.stringify({
        event: 'slack_thread_post_failed',
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        reason: result.reason ?? 'unknown'
      }));
    }
    return result.delivered;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'slack_thread_post_failed',
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      reason: error instanceof Error ? error.message : 'unknown_error'
    }));
    return false;
  }
}

async function postMessageReaction(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }
) {
  try {
    const result = await addSlackReaction(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      name: input.name
    });
    if (!result.delivered) {
      console.warn(JSON.stringify({
        event: 'slack_reaction_add_failed',
        tenantId: input.tenantId,
        channelId: input.channelId,
        messageTs: input.messageTs,
        reaction: input.name,
        reason: result.reason ?? 'unknown'
      }));
    }
    return result.delivered;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'slack_reaction_add_failed',
      tenantId: input.tenantId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      reaction: input.name,
      reason: error instanceof Error ? error.message : 'unknown_error'
    }));
    return false;
  }
}

async function runIntentIntake(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    sourceMessageTs?: string;
    text: string;
    responseUrl?: string;
  }
): Promise<RunKickoff | undefined> {
  const existing = await tenantAuthDb.getSlackIntakeSession(env, input.tenantId, input.channelId, input.threadTs);
  const expired = existing ? isSessionExpired(existing.lastActivityAt) : false;
  if (existing && expired && existing.status === 'active') {
    await tenantAuthDb.upsertSlackIntakeSession(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: 'expired',
      turnCount: existing.turnCount,
      data: existing.data
    });
  }

  const currentTurn = existing?.status === 'active' && !expired ? existing.turnCount : 0;
  const pendingReviewSelection = existing?.status === 'active' && !expired
    ? normalizePendingReviewSelection(existing.data)
    : undefined;
  if (pendingReviewSelection) {
    const selectedRepoId = resolveRepoFromReply(input.text, pendingReviewSelection.choices);
    if (selectedRepoId) {
      const repos = await listTenantRepos(env, input.tenantId);
      const repo = repos.find((candidate) => candidate.repoId === selectedRepoId);
      if (!repo) {
        logSlackMentionIngestion({
          checkpoint: 'review_reply_invalid',
          tenantId: input.tenantId,
          channelId: input.channelId,
          threadTs: input.threadTs,
          repoId: selectedRepoId,
          reviewNumber: pendingReviewSelection.reviewNumber,
          reviewUrl: pendingReviewSelection.reviewUrl,
          reviewProviderHint: pendingReviewSelection.reviewProviderHint,
          message: 'selected repo is no longer available'
        });
      } else {
        const review = resolveReviewCommandForRepo(repo, {
          reviewNumber: pendingReviewSelection.reviewNumber,
          reviewUrl: pendingReviewSelection.reviewUrl,
          providerHint: pendingReviewSelection.reviewProviderHint
        });
        const started = await startReviewRunForTask(
          env,
          ctx,
          input.tenantId,
          repo.repoId,
          review,
          DEFAULT_TASK_LLM_MODEL
        );
        await tenantAuthDb.upsertSlackThreadBinding(env, {
          tenantId: input.tenantId,
          taskId: started.taskId,
          channelId: input.channelId,
          threadTs: input.threadTs,
          currentRunId: started.runId,
          latestReviewRound: DEFAULT_REVIEW_ROUND
        });
        await tenantAuthDb.upsertSlackIntakeSession(env, {
          tenantId: input.tenantId,
          channelId: input.channelId,
          threadTs: input.threadTs,
          status: 'completed',
          turnCount: currentTurn,
          data: {
            lastUserText: input.text
          }
        });
        await postThreadPrompt(env, {
          tenantId: input.tenantId,
          channelId: input.channelId,
          threadTs: input.threadTs,
          text: `Started review-only run ${started.runId} for ${review.reviewProvider} #${review.reviewNumber} in ${repo.repoId}.`
        });
        logSlackMentionIngestion({
          checkpoint: 'review_reply_resolved',
          tenantId: input.tenantId,
          channelId: input.channelId,
          threadTs: input.threadTs,
          repoId: repo.repoId,
          taskId: started.taskId,
          runId: started.runId,
          reviewNumber: review.reviewNumber,
          reviewUrl: review.reviewUrl,
          reviewProviderHint: review.reviewProvider
        });
        return started;
      }
    } else if (input.text.trim()) {
      logSlackMentionIngestion({
        checkpoint: 'review_reply_invalid',
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        reviewNumber: pendingReviewSelection.reviewNumber,
        reviewUrl: pendingReviewSelection.reviewUrl,
        reviewProviderHint: pendingReviewSelection.reviewProviderHint,
        message: `reply did not match choices: ${pendingReviewSelection.choices.join(', ')}`
      });
      await postThreadPrompt(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: [
          `Please reply with a number from 1-${pendingReviewSelection.choices.length} or an exact repo id.`,
          ...pendingReviewSelection.choices.map((choice, index) => `${index + 1}. ${choice}`)
        ].join('\n')
      });
      return undefined;
    }
  }
  const pendingConfirmation = existing?.status === 'active' && !expired
    ? normalizePendingConfirmation(existing.data)
    : undefined;
  if (pendingConfirmation && isAffirmativeConfirmation(input.text)) {
    const payload = buildTaskPayloadFromIntent({
      repoId: pendingConfirmation.repoId,
      title: pendingConfirmation.title,
      prompt: pendingConfirmation.prompt,
      acceptanceCriteria: pendingConfirmation.acceptanceCriteria.length > 0
        ? pendingConfirmation.acceptanceCriteria
        : ['Task is complete and validated in the target repository.'],
      model: toSupportedCodexModel((await resolveSlackIntentScopeConfig(env, input.tenantId, {
        channelId: input.channelId
      })).settings.intentModel)
    });
    const started = await startRunForTask(env, ctx, input.tenantId, pendingConfirmation.repoId, payload);
    await tenantAuthDb.upsertSlackThreadBinding(env, {
      tenantId: input.tenantId,
      taskId: started.taskId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      currentRunId: started.runId,
      latestReviewRound: DEFAULT_REVIEW_ROUND
    });
    await tenantAuthDb.upsertSlackIntakeSession(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: 'completed',
      turnCount: currentTurn,
      data: {
        lastUserText: input.text
      }
    });
    await postThreadPrompt(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: `Created task ${started.taskId} and started run ${started.runId} in ${pendingConfirmation.repoId}.`
    });
    return started;
  }
  const previousIntent = existing?.status === 'active' && !expired
    ? normalizeSessionIntentData(existing.data)
    : {};
  const sessionRepoChoices = existing?.status === 'active' && !expired
    ? normalizeRepoChoicesFromSession(existing.data)
    : [];
  const selectedRepoFromNumber = resolveRepoFromNumberReply(input.text, sessionRepoChoices);
  if (selectedRepoFromNumber) {
    previousIntent.repoId = selectedRepoFromNumber;
    previousIntent.repoHint = selectedRepoFromNumber;
  }
  const { settings } = await resolveSlackIntentScopeConfig(env, input.tenantId, {
    channelId: input.channelId
  });
  const availableRepos = await listAvailableRepoIdsForTenant(env, input.tenantId);
  const parsed = mergeIntentWithSession(await parseSlackIntentWithLlm(env, {
    text: buildIntentParseInputText(input.text, previousIntent),
    settings,
    priorTurns: currentTurn,
    availableRepos,
    onRequestStart: async ({ attempt }) => {
      if (attempt !== 1) {
        return;
      }
      if (input.sourceMessageTs?.trim()) {
        const reacted = await postMessageReaction(env, {
          tenantId: input.tenantId,
          channelId: input.channelId,
          messageTs: input.sourceMessageTs.trim(),
          name: 'eyes'
        });
        if (reacted) {
          return;
        }
      }
      await postThreadPrompt(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: ':eyes:'
      });
    }
  }), previousIntent, input.text);
  if (!parsed.taskPrompt?.trim() && !isLikelyRepoOnlyText(input.text)) {
    parsed.taskPrompt = input.text.trim();
  }
  if (!parsed.taskTitle?.trim() && parsed.taskPrompt?.trim()) {
    parsed.taskTitle = deriveTaskTitleFromPrompt(parsed.taskPrompt);
  }

  const repoResolution = await resolveRepoIdForIntent(env, input.tenantId, input.channelId, parsed);
  const missingFields = normalizeIntentMissingFields(parsed.missingFields, Boolean(repoResolution.repoId));
  const hasCoreFields = Boolean(repoResolution.repoId)
    && Boolean(parsed.taskPrompt?.trim())
    && Boolean(parsed.taskTitle?.trim());
  const isCompleteByConfidence = parsed.confidence >= AUTO_CREATE_CONFIDENCE_THRESHOLD
    && parsed.intent === 'create_task'
    && hasCoreFields
    && missingFields.length === 0;
  const isCompleteByTurnFallback = parsed.intent === 'create_task'
    && hasCoreFields
    && currentTurn >= Math.max(1, settings.intentClarifyMaxTurns - 1);
  const isReadyForConfirmation = parsed.intent === 'create_task'
    && hasCoreFields
    && missingFields.filter((field) => field !== 'acceptanceCriteria').length === 0;
  const isComplete = isReadyForConfirmation || isCompleteByConfidence || isCompleteByTurnFallback;

  if (isComplete && settings.intentAutoCreate && repoResolution.repoId) {
    const title = parsed.taskTitle!.trim();
    const prompt = parsed.taskPrompt!.trim();
    const acceptanceCriteria = parsed.acceptanceCriteria.length > 0
      ? parsed.acceptanceCriteria
      : ['Task is complete and validated in the target repository.'];
    await tenantAuthDb.upsertSlackIntakeSession(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: 'active',
      turnCount: currentTurn,
      lastConfidence: parsed.confidence,
      data: {
        ...parsed,
        lastUserText: input.text,
        pendingConfirmation: {
          repoId: repoResolution.repoId,
          title,
          prompt,
          acceptanceCriteria
        }
      }
    });
    await postThreadPrompt(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: buildSlackTaskSummary({
        repoId: repoResolution.repoId,
        title,
        prompt,
        acceptanceCriteria
      })
    });
    return undefined;
  }

  const nextTurn = currentTurn + 1;
  const maxTurns = settings.intentClarifyMaxTurns;
  const needsRepoDisambiguation = !repoResolution.repoId && repoResolution.ambiguous && repoResolution.choices.length > 0;
  const disambiguationChoices = needsRepoDisambiguation ? repoResolution.choices.slice(0, 9) : [];
  const question = needsRepoDisambiguation
    ? [
      'I found multiple possible repos. Did you mean:',
      ...disambiguationChoices.map((repoId, index) => `${index + 1}: ${repoId}`),
      'Reply with the number.'
    ].join('\n')
    : parsed.clarifyingQuestion
      ?? 'Please clarify repo, exact goal, and acceptance criteria.';

  await tenantAuthDb.upsertSlackIntakeSession(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    status: nextTurn >= maxTurns ? 'active' : 'active',
    turnCount: nextTurn,
    lastConfidence: parsed.confidence,
    data: {
      ...parsed,
      missingFields,
      clarifyingQuestion: question,
      lastUserText: input.text,
      ...(disambiguationChoices.length > 0 ? { repoChoices: disambiguationChoices } : {})
    }
  });

  if (nextTurn >= maxTurns && !needsRepoDisambiguation && !parsed.taskPrompt?.trim() && !parsed.taskTitle?.trim()) {
    const handoff = [
      `I still need more detail after ${maxTurns} clarification turns.`,
      'Please hand off in a structured format:',
      '`repo=<repo_id>; title=<short title>; prompt=<goal>; acceptance=<item1 | item2>`'
    ].join('\n');
    if (input.responseUrl) {
      await postSlackResponse(input.responseUrl, { response_type: 'ephemeral', text: handoff });
    } else {
      await postThreadPrompt(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: handoff
      });
    }
    return undefined;
  }

  if (input.responseUrl) {
    await postSlackResponse(input.responseUrl, { response_type: 'ephemeral', text: question });
    return undefined;
  }
  await postThreadPrompt(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: question
  });
  return undefined;
}

async function ensureThreadForChannelIntake(env: Env, input: {
  tenantId: string;
  channelId: string;
  userId: string;
  responseUrl?: string;
}): Promise<string | undefined> {
  const kickoff = await postSlackChannelMessage(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    text: `Starting /kanvy intake for <@${input.userId}>. Continue in this thread.`
  });
  if (!kickoff.delivered || !kickoff.ts) {
    await postSlackResponse(input.responseUrl, {
      response_type: 'ephemeral',
      text: 'Unable to create a thread for intake continuation. Please retry in a thread.'
    });
    return undefined;
  }

  await postSlackResponse(input.responseUrl, {
    response_type: 'ephemeral',
    text: `Continuing in thread: ${formatSlackThreadLink(input.channelId, kickoff.ts)}`
  });
  return kickoff.ts;
}

async function runSlackCommandAsync(
  env: Env,
  payload: ReturnType<typeof parseSlackSlashCommandBody>,
  ctx?: ExecutionContext<unknown>
) {
  const tenantId = await resolveThreadTenantId(env, payload.teamId);
  const normalizedText = payload.text.trim();
  const reviewInput = parseReviewFastPathInput(normalizedText)
    ?? (normalizedText && normalizedText.toLowerCase() !== 'help' && shouldAttemptReviewIntentLlm(normalizedText)
      ? await detectReviewCommandWithIntent(env, {
        tenantId,
        channelId: payload.channelId,
        text: normalizedText
      })
      : undefined);
  let issueKey = reviewInput ? undefined : parseJiraFastPathIssueKey(payload.text);
  if (!reviewInput && !issueKey && normalizedText && normalizedText.toLowerCase() !== 'help') {
    issueKey = await detectJiraIssueKeyWithIntent(env, {
      tenantId,
      channelId: payload.channelId,
      text: payload.text
    });
  }
  logSlackCommandLifecycle({
    checkpoint: 'received',
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    issueKey: issueKey ?? undefined
  });

  if (normalizedText.toLowerCase() === 'help') {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: KANVY_HELP_TEXT
    });
    return;
  }

  const dedupeSubject = reviewInput
    ? `review:${reviewInput.reviewUrl ?? reviewInput.reviewNumber}`
    : issueKey ?? (normalizedText || 'empty');
  const slashDedupeKey = buildIdempotencyKey({
    provider: 'slack',
    tenantId,
    eventType: reviewInput ? 'slash_command.review' : issueKey ? 'slash_command.fix' : 'slash_command.intent',
    providerEventId: payload.responseUrl ?? `${payload.teamId ?? 'team:default'}:${payload.channelId}:${dedupeSubject}`,
    subjectId: `${payload.channelId}:${payload.threadTs ?? 'root'}`,
    metadata: {
      issueKey: issueKey ?? null,
      userId: payload.userId
    }
  });
  if (!(await markIngressDeliveryIfNew(env, slashDedupeKey))) {
    logSlackCommandLifecycle({
      checkpoint: 'deduped',
      tenantId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      issueKey: issueKey ?? undefined,
      dedupeKey: slashDedupeKey,
      deduped: true
    });
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: issueKey
        ? `Duplicate /kanvy command ignored for ${issueKey}.`
        : 'Duplicate /kanvy command ignored.'
    });
    return;
  }
  logSlackCommandLifecycle({
    checkpoint: 'deduped',
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    issueKey: issueKey ?? undefined,
    dedupeKey: slashDedupeKey,
    deduped: false
  });

  if (!normalizedText) {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: 'Usage: `/kanvy fix ABC-123`, `/kanvy review <MR_NUMBER|MR_URL>`, or `/kanvy <free-text request>`.'
    });
    return;
  }

  if (reviewInput) {
    const reviewThreadTs = payload.threadTs
      ?? await ensureThreadForChannelIntake(env, {
        tenantId,
        channelId: payload.channelId,
        userId: payload.userId,
        responseUrl: payload.responseUrl
      });
    if (!reviewThreadTs) {
      return;
    }
    try {
      const started = await processReviewCommandFlow(env, ctx, {
        tenantId,
        channelId: payload.channelId,
        threadTs: reviewThreadTs,
        responseUrl: payload.responseUrl,
        review: reviewInput
      });
      if (started) {
        logSlackCommandLifecycle({
          checkpoint: 'task_started',
          tenantId,
          channelId: payload.channelId,
          threadTs: reviewThreadTs,
          taskId: started.taskId,
          runId: started.runId
        });
      }
    } catch (error) {
      await postSlackResponse(payload.responseUrl, {
        response_type: 'ephemeral',
        text: `Failed to process /kanvy review command: ${toReadableErrorMessage(error)}`
      });
    }
    return;
  }

  if (!issueKey) {
    const threadTs = payload.threadTs
      ?? await ensureThreadForChannelIntake(env, {
        tenantId,
        channelId: payload.channelId,
        userId: payload.userId,
        responseUrl: payload.responseUrl
      });
    if (!threadTs) return;
    try {
      const started = await runIntentIntake(env, ctx, {
        tenantId,
        channelId: payload.channelId,
        threadTs,
        text: payload.text,
        responseUrl: payload.threadTs ? payload.responseUrl : undefined
      });
      if (started) {
        logSlackCommandLifecycle({
          checkpoint: 'task_started',
          tenantId,
          channelId: payload.channelId,
          threadTs,
          taskId: started.taskId,
          runId: started.runId
        });
      }
    } catch (error) {
      await postSlackResponse(payload.responseUrl, {
        response_type: 'ephemeral',
        text: `Failed to process /kanvy command: ${toReadableErrorMessage(error)}`
      });
    }
    return;
  }

  const issueThreadTs = payload.threadTs
    ?? await ensureThreadForChannelIntake(env, {
      tenantId,
      channelId: payload.channelId,
      userId: payload.userId,
      responseUrl: payload.responseUrl
    });
  if (!issueThreadTs) {
    return;
  }
  const bindingTaskId = await createThreadBindingForSlashCommand(env, tenantId, issueKey, payload.channelId, issueThreadTs);
  await postThreadPrompt(env, {
    tenantId,
    channelId: payload.channelId,
    threadTs: issueThreadTs,
    text: `Analyzing Jira issue ${issueKey} and preparing a task summary. Hold tight.`
  });

  try {
    const jiraTarget = resolveJiraRequestTarget(env, issueKey);
    logSlackCommandLifecycle({
      checkpoint: 'jira_fetch_started',
      tenantId,
      channelId: payload.channelId,
      threadTs: issueThreadTs,
      issueKey,
      jiraHost: jiraTarget.host,
      jiraPath: jiraTarget.path
    });
    const issue = await resolveTenantAndJiraIssue(env, tenantId, issueKey);
    console.info(JSON.stringify({
      event: 'slack_jira_issue_loaded',
      tenantId,
      channelId: payload.channelId,
      threadTs: issueThreadTs,
      issueKey: issue.issueKey
    }));
    const { settings, config } = await resolveSlackIntentScopeConfig(env, tenantId, {
      channelId: payload.channelId
    });
    const scopedRepoId = config?.scopeType === 'repo' && config.scopeId?.trim()
      ? config.scopeId.trim()
      : undefined;
    const contextRepoId = await resolvePreferredRepoFromChannelContext(env, tenantId, payload.channelId);
    const preferredRepoId = scopedRepoId || settings.defaultRepoId?.trim() || contextRepoId || undefined;
    const started = await processJiraIssueFlow(env, ctx, tenantId, issue, {
      taskId: bindingTaskId,
      channelId: payload.channelId,
      threadTs: issueThreadTs,
      latestReviewRound: DEFAULT_REVIEW_ROUND
    }, payload.responseUrl, toSupportedCodexModel(settings.intentModel), payload.text, settings, preferredRepoId);
    if (started) {
      logSlackCommandLifecycle({
        checkpoint: 'task_started',
        tenantId,
        channelId: payload.channelId,
        threadTs: issueThreadTs,
        issueKey,
        taskId: started.taskId,
        runId: started.runId
      });
    }
  } catch (error) {
    const jiraFailure = parseJiraFailureCategory(error);
    logSlackCommandLifecycle({
      checkpoint: 'jira_fetch_failed',
      tenantId,
      channelId: payload.channelId,
      threadTs: issueThreadTs,
      issueKey,
      jiraFailureCategory: jiraFailure.category,
      jiraStatus: jiraFailure.status,
      message: toReadableErrorMessage(error)
    });
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: `Failed to process /kanvy command for ${issueKey}: ${toReadableErrorMessage(error)}`
    });
  }
}

async function runSlackMentionAsync(
  env: Env,
  payload: {
    teamId?: string;
    channelId: string;
    threadTs: string;
    eventTs?: string;
    userId?: string;
    text: string;
    eventType?: string;
    channelType?: string;
  },
  ctx?: ExecutionContext<unknown>
) {
  logSlackMentionIngestion({
    checkpoint: 'received',
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    eventTs: payload.eventTs,
    userId: payload.userId,
    eventType: payload.eventType,
    channelType: payload.channelType,
    rawText: payload.text
  });
  const tenantId = await resolveThreadTenantId(env, payload.teamId);
  const normalizedText = normalizeKanvyInvocationText(payload.text, {
    eventType: payload.eventType,
    channelType: payload.channelType
  });
  logSlackMentionIngestion({
    checkpoint: 'normalized',
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    eventTs: payload.eventTs,
    userId: payload.userId,
    eventType: payload.eventType,
    channelType: payload.channelType,
    rawText: payload.text,
    normalizedText
  });
  if (!normalizedText) {
    logSlackMentionIngestion({
      checkpoint: 'ignored',
      tenantId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      eventTs: payload.eventTs,
      userId: payload.userId,
      eventType: payload.eventType,
      channelType: payload.channelType,
      rawText: payload.text,
      message: 'normalizeKanvyInvocationText returned empty'
    });
    return;
  }

  const reviewInput = parseReviewFastPathInput(normalizedText)
    ?? (shouldAttemptReviewIntentLlm(normalizedText)
      ? await detectReviewCommandWithIntent(env, {
        tenantId,
        channelId: payload.channelId,
        text: normalizedText
      })
      : undefined);
  if (reviewInput) {
    logSlackMentionIngestion({
      checkpoint: 'review_detected',
      tenantId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      eventTs: payload.eventTs,
      userId: payload.userId,
      eventType: payload.eventType,
      channelType: payload.channelType,
      normalizedText,
      reviewNumber: reviewInput.reviewNumber,
      reviewUrl: reviewInput.reviewUrl,
      reviewProviderHint: reviewInput.providerHint
    });
  }
  const eventDedupeKey = buildIdempotencyKey({
    provider: 'slack',
    tenantId,
    eventType: reviewInput ? 'event.mention.review' : 'event.mention.intent',
    providerEventId: payload.eventTs ?? `${payload.channelId}:${payload.threadTs}:${normalizedText}`,
    subjectId: `${payload.channelId}:${payload.threadTs}`,
    metadata: {
      userId: payload.userId ?? null
    }
  });
  if (!(await markIngressDeliveryIfNew(env, eventDedupeKey))) {
    logSlackMentionIngestion({
      checkpoint: 'deduped',
      tenantId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      eventTs: payload.eventTs,
      userId: payload.userId,
      eventType: payload.eventType,
      channelType: payload.channelType,
      normalizedText,
      dedupeKey: eventDedupeKey,
      deduped: true
    });
    return;
  }
  logSlackMentionIngestion({
    checkpoint: 'deduped',
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    eventTs: payload.eventTs,
    userId: payload.userId,
    eventType: payload.eventType,
    channelType: payload.channelType,
    normalizedText,
    dedupeKey: eventDedupeKey,
    deduped: false
  });

  if (normalizedText.toLowerCase() === 'help') {
    await postThreadPrompt(env, {
      tenantId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      text: KANVY_HELP_TEXT
    });
    return;
  }

  if (reviewInput) {
    try {
      await processReviewCommandFlow(env, ctx, {
        tenantId,
        channelId: payload.channelId,
        threadTs: payload.threadTs,
        review: reviewInput
      });
    } catch (error) {
      logSlackMentionIngestion({
        checkpoint: 'review_flow_failed',
        tenantId,
        channelId: payload.channelId,
        threadTs: payload.threadTs,
        eventTs: payload.eventTs,
        userId: payload.userId,
        eventType: payload.eventType,
        channelType: payload.channelType,
        normalizedText,
        reviewNumber: reviewInput.reviewNumber,
        reviewUrl: reviewInput.reviewUrl,
        reviewProviderHint: reviewInput.providerHint,
        error
      });
      throw error;
    }
    return;
  }

  const threadMessages = await fetchSlackThreadMessages(env, {
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    limit: 12
  });
  const intakeText = buildIntentTextWithThreadContext(normalizedText, threadMessages);
  logSlackMentionIngestion({
    checkpoint: 'intent_flow_started',
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    eventTs: payload.eventTs,
    userId: payload.userId,
    eventType: payload.eventType,
    channelType: payload.channelType,
    normalizedText,
    message: `thread_context_messages=${threadMessages.length}`
  });
  await runIntentIntake(env, ctx, {
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    sourceMessageTs: payload.eventTs,
    text: intakeText
  });
}

async function handleRepoDisambiguationAction(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  tenantId: string,
  interaction: ParsedSlackInteraction
): Promise<Response> {
  const repoId = interaction.repoId?.trim();
  const issueKey = interaction.issueKey?.trim();
  if (!repoId || !issueKey) {
    throw badRequest('Missing repository or issue context in repo disambiguation action.');
  }

  const issue = normalizeJiraIssueFromInteraction({
    issueKey,
    issueTitle: interaction.issueTitle,
    issueBody: interaction.issueBody,
    issueUrl: interaction.issueUrl
  });

  const resolvedIssue = issue.title === issueKey && issue.body === 'No description provided.'
    ? await resolveTenantAndJiraIssue(env, tenantId, issueKey)
    : issue;

  const payload = buildTaskPayloadFromIssue(resolvedIssue, repoId);
  const started = await startRunForTask(env, ctx, tenantId, repoId, payload);
  if (interaction.threadTs) {
    await syncSlackBindingAfterRunStart(env, tenantId, interaction.taskId, {
      taskId: started.taskId,
      channelId: interaction.channelId,
      threadTs: interaction.threadTs,
      runId: started.runId,
      latestReviewRound: normalizeLatestReviewRound(interaction.latestReviewRound)
    });
  }

  return json({
    ok: true,
    action: interaction.actionId,
    taskId: started.taskId,
    runId: started.runId,
    repoId
  });
}

async function handleReviewRepoDisambiguationAction(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  tenantId: string,
  interaction: ParsedSlackInteraction
): Promise<Response> {
  const repoId = interaction.repoId?.trim();
  const reviewNumber = interaction.reviewNumber;
  const reviewProvider = interaction.reviewProvider;
  if (!repoId || !reviewNumber || !reviewProvider) {
    throw badRequest('Missing repository or review context in review repo disambiguation action.');
  }
  const repos = await listTenantRepos(env, tenantId);
  const repo = repos.find((candidate) => candidate.repoId === repoId);
  if (!repo) {
    throw badRequest(`Repo ${repoId} is not available for this tenant.`);
  }
  const review = resolveReviewCommandForRepo(repo, {
    reviewNumber,
    reviewUrl: interaction.reviewUrl,
    providerHint: reviewProvider
  });
  const started = await startReviewRunForTask(
    env,
    ctx,
    tenantId,
    repoId,
    review,
    DEFAULT_TASK_LLM_MODEL
  );
  if (interaction.threadTs) {
    await tenantAuthDb.upsertSlackThreadBinding(env, {
      tenantId,
      taskId: started.taskId,
      channelId: interaction.channelId,
      threadTs: interaction.threadTs,
      currentRunId: started.runId,
      latestReviewRound: DEFAULT_REVIEW_ROUND
    });
  }
  return json({
    ok: true,
    action: interaction.actionId,
    taskId: started.taskId,
    runId: started.runId,
    repoId
  });
}

export async function handleSlackCommands(
  request: Request,
  env: Env,
  ctx: ExecutionContext<unknown>
): Promise<Response> {
  try {
    const rawBody = await request.text();
    await verifySlackRequest(env, request, rawBody);
    const payload = parseSlackSlashCommandBody(rawBody);
    const job = runSlackCommandAsync(env, payload, ctx);
    if (ctx?.waitUntil) {
      ctx.waitUntil(job);
    } else {
      await job;
    }
    return json({
      ok: true,
      text: 'Accepted /kanvy command.'
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSlackEvents(request: Request, env: Env): Promise<Response> {
  try {
    const rawBody = await request.text();
    await verifySlackRequest(env, request, rawBody);
    const payload = parseSlackEventBody(rawBody);
    if (payload.type === 'url_verification' && payload.challenge) {
      return json({ challenge: payload.challenge });
    }
    if (
      payload.event
      && (payload.event.type === 'message' || payload.event.type === 'app_mention')
      && payload.event.channelId
      && payload.event.text
      && !payload.event.botId
    ) {
      const threadTs = payload.event.threadTs ?? payload.event.ts;
      if (!threadTs) {
        return json({ ok: true, status: 'accepted' });
      }

      const invocationText = normalizeKanvyInvocationText(payload.event.text, {
        eventType: payload.event.type,
        channelType: payload.event.channelType
      });
      if (invocationText) {
        logSlackMentionIngestion({
          checkpoint: 'received',
          channelId: payload.event.channelId,
          threadTs,
          eventTs: payload.event.ts,
          userId: payload.event.userId,
          eventType: payload.event.type,
          channelType: payload.event.channelType,
          rawText: payload.event.text,
          normalizedText: invocationText
        });
        await runSlackMentionAsync(env, {
          teamId: payload.teamId,
          channelId: payload.event.channelId,
          threadTs,
          eventTs: payload.event.ts,
          userId: payload.event.userId,
          text: payload.event.text,
          eventType: payload.event.type,
          channelType: payload.event.channelType
        });
        return json({ ok: true, status: 'accepted' });
      }
      logSlackMentionIngestion({
        checkpoint: 'ignored',
        channelId: payload.event.channelId,
        threadTs,
        eventTs: payload.event.ts,
        userId: payload.event.userId,
        eventType: payload.event.type,
        channelType: payload.event.channelType,
        rawText: payload.event.text,
        message: 'Event message did not resolve to a @kanvy invocation'
      });

      if (payload.event.type === 'message' && payload.event.threadTs) {
        const tenantId = await resolveThreadTenantId(env, payload.teamId);
        const eventDedupeKey = buildIdempotencyKey({
          provider: 'slack',
          tenantId,
          eventType: 'event.thread_message',
          providerEventId: payload.eventId ?? `${payload.event.channelId}:${payload.event.ts ?? payload.event.threadTs}`,
          subjectId: `${payload.event.channelId}:${payload.event.threadTs}`,
          metadata: {
            userId: payload.event.userId ?? null
          }
        });
        if (!(await markIngressDeliveryIfNew(env, eventDedupeKey))) {
          return json({ ok: true, status: 'duplicate_event_ignored' });
        }
        const session = await tenantAuthDb.getSlackIntakeSession(env, tenantId, payload.event.channelId, payload.event.threadTs);
        if (session?.status === 'active') {
          await runIntentIntake(env, undefined, {
            tenantId,
            channelId: payload.event.channelId,
            threadTs: payload.event.threadTs,
            sourceMessageTs: payload.event.ts,
            text: payload.event.text
          });
        }
      }
    }
    return json({ ok: true, status: 'accepted' });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSlackInteractions(
  request: Request,
  env: Env,
  ctx: ExecutionContext<unknown>
): Promise<Response> {
  try {
    const rawBody = await request.text();
    await verifySlackRequest(env, request, rawBody);
    const interaction = parseSlackInteractionBody(rawBody);
    const tenantId = await resolveThreadTenantId(env, interaction.tenantId || interaction.teamId);
    const interactionDedupeKey = buildIdempotencyKey({
      provider: 'slack',
      tenantId,
      eventType: `interaction.${interaction.actionId}`,
      providerEventId: `${interaction.actionId}:${interaction.currentRunId ?? interaction.issueKey ?? interaction.taskId}`,
      subjectId: `${interaction.channelId}:${interaction.threadTs || 'root'}`,
      metadata: {
        taskId: interaction.taskId,
        repoId: interaction.repoId ?? null,
        latestReviewRound: interaction.latestReviewRound ?? -1
      }
    });
    if (!(await markIngressDeliveryIfNew(env, interactionDedupeKey))) {
      return json({
        ok: true,
        status: 'duplicate_interaction_ignored',
        action: interaction.actionId,
        taskId: interaction.taskId
      });
    }
    if (interaction.actionId === 'repo_disambiguation') {
      return handleRepoDisambiguationAction(env, ctx, tenantId, interaction);
    }
    if (interaction.actionId === 'review_repo_disambiguation') {
      return handleReviewRepoDisambiguationAction(env, ctx, tenantId, interaction);
    }
    if (interaction.actionId === 'approve_rerun') {
      await startSlackApprovedRerun(env, ctx, tenantId, interaction);
      return json({
        ok: true,
        action: interaction.actionId,
        taskId: interaction.taskId,
        ...(interaction.repoId ? { repoId: interaction.repoId } : {})
      });
    }
    if (interaction.actionId === 'pause') {
      const repoId = interaction.currentRunId
        ? await resolveRepoIdForRun(env, interaction.currentRunId)
        : undefined;
      await pauseSlackRun(env, tenantId, interaction, repoId);
    }
    await updateBindingForAction(env, tenantId, interaction);
    return json({
      ok: true,
      action: interaction.actionId,
      taskId: interaction.taskId,
      ...(interaction.repoId ? { repoId: interaction.repoId } : {})
    });
  } catch (error) {
    return handleError(error);
  }
}
