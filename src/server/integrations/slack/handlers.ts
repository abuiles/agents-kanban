import type { IntegrationIssueRef } from '../interfaces';
import type { CreateTaskInput } from '../../../ui/domain/api';
import { badRequest } from '../../http/errors';
import { handleError, json } from '../../http/response';
import * as tenantAuthDb from '../../tenant-auth-db';
import { createJiraIssueSourceIntegrationFromEnv } from '../jira/client';
import { scheduleRunJob } from '../../run-orchestrator';
import { buildIdempotencyKey } from '../idempotency';
import {
  parseJiraFastPathIssueKey,
  parseSlackEventBody,
  parseSlackInteractionBody,
  parseSlackSlashCommandBody,
  type ParsedSlackInteraction
} from './payload';
import { resolveThreadTenant, verifySlackRequest } from './verification';
import { mirrorRunLifecycleMilestone } from './timeline';
import { postSlackChannelMessage, postSlackThreadMessage } from './client';
import { resolveIntegrationConfig } from '../config-resolution';
import {
  parseSlackIntentWithLlm,
  resolveSlackIntentSettings,
  type SlackIntentParseResult
} from './intent';

const DEFAULT_TASK_ID_PREFIX = 'issue';
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
  'Usage: `/kanvy fix <JIRA_KEY>` or `/kanvy help`.',
  'Examples:',
  '- Jira fast-path: `/kanvy fix ABC-123`',
  '- Free-text flow: `/kanvy Investigate flaky checkout tests and propose a fix plan`'
].join('\n');
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const AUTO_CREATE_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_JIRA_API_PATH_PREFIX = '/rest/api/3/issue';
const MAX_LOG_MESSAGE_CHARS = 300;

type SlackLifecycleCheckpoint = 'received' | 'deduped' | 'jira_fetch_started' | 'jira_fetch_failed' | 'task_started';

type RepoDisambiguationChoice = {
  repoId: string;
  label: string;
};

type RunKickoff = {
  taskId: string;
  runId: string;
};

function buildTaskIdFromIssue(issueKey: string) {
  return `${DEFAULT_TASK_ID_PREFIX}:${issueKey}`;
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

function formatSlackThreadLink(channelId: string, threadTs: string) {
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}&message_ts=${encodeURIComponent(threadTs)}`;
}

function buildTaskPromptFromIssue(issue: IntegrationIssueRef) {
  return `Fix Jira issue ${issue.issueKey}: ${issue.title}\n\n${issue.body}`.trim();
}

function buildTaskPayloadFromIssue(
  issue: IntegrationIssueRef,
  repoId: string,
  model = DEFAULT_TASK_LLM_MODEL
): CreateTaskInput {
  return {
    repoId,
    title: `[${issue.issueKey}] ${issue.title}`.trim(),
    description: issue.body,
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

function buildTaskPayloadFromIntent(input: {
  repoId: string;
  title: string;
  prompt: string;
  acceptanceCriteria: string[];
  model: CreateTaskInput['codexModel'];
}): CreateTaskInput {
  return {
    repoId: input.repoId,
    title: input.title,
    description: input.prompt,
    sourceRef: SOURCE_REF,
    taskPrompt: input.prompt,
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

async function resolveRepoIdForIntent(
  env: Env,
  tenantId: string,
  channelId: string,
  parsed: SlackIntentParseResult
) {
  if (parsed.repoId?.trim()) {
    return { repoId: parsed.repoId.trim(), ambiguous: false, choices: [] as string[] };
  }

  const { settings } = await resolveSlackIntentScopeConfig(env, tenantId, {
    channelId,
    repoId: undefined
  });
  if (settings.defaultRepoId?.trim()) {
    return { repoId: settings.defaultRepoId.trim(), ambiguous: false, choices: [] as string[] };
  }

  const boardIndex = env.BOARD_INDEX?.getByName(BOARD_OBJECT_NAME);
  if (!boardIndex) {
    return { repoId: undefined, ambiguous: false, choices: [] as string[] };
  }
  try {
    const repos = await boardIndex.listRepos(tenantId);
    if (repos.length === 1 && repos[0]?.repoId) {
      return { repoId: repos[0].repoId, ambiguous: false, choices: [] as string[] };
    }
    if (repos.length > 1) {
      const choices = repos.map((repo) => repo.repoId).filter((repoId): repoId is string => Boolean(repoId));
      if (parsed.repoHint?.trim()) {
        const hint = parsed.repoHint.trim().toLowerCase();
        const exact = choices.find((repoId) => repoId.toLowerCase() === hint);
        if (exact) {
          return { repoId: exact, ambiguous: false, choices };
        }
        const partial = choices.find((repoId) => repoId.toLowerCase().includes(hint));
        if (partial) {
          return { repoId: partial, ambiguous: false, choices };
        }
      }
      return { repoId: undefined, ambiguous: true, choices };
    }
  } catch {
    // Best effort.
  }
  return { repoId: undefined, ambiguous: false, choices: [] as string[] };
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

async function startRunForTask(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  tenantId: string,
  repoId: string,
  taskPayload: ReturnType<typeof buildTaskPayloadFromIssue>
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
  llmModel: CreateTaskInput['codexModel'] = DEFAULT_TASK_LLM_MODEL
): Promise<RunKickoff | undefined> {
  const issueProjectKey = issueProjectKeyFromIssue(issue.issueKey);
  const mappings = await tenantAuthDb.listJiraProjectRepoMappingsByProject(env, tenantId, issueProjectKey, true);
  if (mappings.length === 0) {
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
  const payload = buildTaskPayloadFromIssue(issue, repoId, llmModel);
  try {
    const started = await startRunForTask(env, ctx, tenantId, repoId, payload);
    if (bindings.threadTs) {
      await syncSlackBindingAfterRunStart(env, tenantId, bindings.taskId, {
        taskId: started.taskId,
        channelId: bindings.channelId,
        threadTs: bindings.threadTs,
        runId: started.runId,
        latestReviewRound: normalizeLatestReviewRound(bindings.latestReviewRound)
      });
    }
    await postSlackResponse(responseUrl, {
      response_type: 'ephemeral',
      text: `Started ${issue.issueKey} in repo ${repoId} (task ${started.taskId}, run ${started.runId}).`
    });
    return started;
  } catch (error) {
    await postSlackResponse(responseUrl, {
      response_type: 'ephemeral',
      text: `Failed to start a run for ${issue.issueKey}: ${toReadableErrorMessage(error)}`
    });
    throw error;
  }
}

async function resolveThreadTenantId(env: Env, teamId: string | undefined) {
  const fallbackTenantId = await tenantAuthDb.getPrimaryTenantId(env);
  return resolveThreadTenant(fallbackTenantId, teamId);
}

async function updateBindingForAction(
  env: Env,
  tenantId: string,
  interaction: ParsedSlackInteraction
) {
  if (interaction.actionId === 'repo_disambiguation') {
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
  await postSlackThreadMessage(env, {
    tenantId: input.tenantId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: input.text
  }).catch(() => {});
}

async function runIntentIntake(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
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
  const { settings } = await resolveSlackIntentScopeConfig(env, input.tenantId, {
    channelId: input.channelId
  });
  const parsed = await parseSlackIntentWithLlm(env, {
    text: input.text,
    settings,
    priorTurns: currentTurn
  });

  const repoResolution = await resolveRepoIdForIntent(env, input.tenantId, input.channelId, parsed);
  const missingFields = normalizeIntentMissingFields(parsed.missingFields, Boolean(repoResolution.repoId));
  const isComplete = parsed.confidence >= AUTO_CREATE_CONFIDENCE_THRESHOLD
    && parsed.intent === 'create_task'
    && Boolean(parsed.taskPrompt?.trim())
    && Boolean(parsed.taskTitle?.trim())
    && missingFields.length === 0;

  if (isComplete && settings.intentAutoCreate && repoResolution.repoId) {
    const payload = buildTaskPayloadFromIntent({
      repoId: repoResolution.repoId,
      title: parsed.taskTitle!.trim(),
      prompt: parsed.taskPrompt!.trim(),
      acceptanceCriteria: parsed.acceptanceCriteria.length > 0
        ? parsed.acceptanceCriteria
        : ['Task is complete and validated in the target repository.'],
      model: toSupportedCodexModel(settings.intentModel)
    });
    const started = await startRunForTask(env, ctx, input.tenantId, repoResolution.repoId, payload);
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
      lastConfidence: parsed.confidence,
      data: {
        ...parsed,
        lastUserText: input.text
      }
    });
    const completionText = `Created task ${started.taskId} and started run ${started.runId} in ${repoResolution.repoId}.`;
    if (input.responseUrl) {
      await postSlackResponse(input.responseUrl, { response_type: 'ephemeral', text: completionText });
    } else {
      await postThreadPrompt(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: completionText
      });
    }
    return started;
  }

  const nextTurn = currentTurn + 1;
  const maxTurns = settings.intentClarifyMaxTurns;
  const needsRepoDisambiguation = !repoResolution.repoId && repoResolution.ambiguous && repoResolution.choices.length > 0;
  const question = needsRepoDisambiguation
    ? `I found multiple repos: ${repoResolution.choices.join(', ')}. Which repo should I use?`
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
      lastUserText: input.text
    }
  });

  if (nextTurn >= maxTurns) {
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
  const issueKey = parseJiraFastPathIssueKey(payload.text);
  logSlackCommandLifecycle({
    checkpoint: 'received',
    tenantId,
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    issueKey: issueKey ?? undefined
  });

  if (payload.text.trim().toLowerCase() === 'help') {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: KANVY_HELP_TEXT
    });
    return;
  }

  const dedupeSubject = issueKey ?? (payload.text.trim() || 'empty');
  const slashDedupeKey = buildIdempotencyKey({
    provider: 'slack',
    tenantId,
    eventType: issueKey ? 'slash_command.fix' : 'slash_command.intent',
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

  if (!payload.text.trim()) {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: 'Usage: `/kanvy fix ABC-123` or `/kanvy <free-text request>`.'
    });
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

  const bindingTaskId = payload.threadTs
    ? await createThreadBindingForSlashCommand(env, tenantId, issueKey, payload.channelId, payload.threadTs)
    : buildTaskIdFromIssue(issueKey);

  try {
    const jiraTarget = resolveJiraRequestTarget(env, issueKey);
    logSlackCommandLifecycle({
      checkpoint: 'jira_fetch_started',
      tenantId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      issueKey,
      jiraHost: jiraTarget.host,
      jiraPath: jiraTarget.path
    });
    const issue = await resolveTenantAndJiraIssue(env, tenantId, issueKey);
    const { settings } = await resolveSlackIntentScopeConfig(env, tenantId, {
      channelId: payload.channelId
    });
    const started = await processJiraIssueFlow(env, ctx, tenantId, issue, {
      taskId: bindingTaskId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      latestReviewRound: DEFAULT_REVIEW_ROUND
    }, payload.responseUrl, toSupportedCodexModel(settings.intentModel));
    if (started) {
      logSlackCommandLifecycle({
        checkpoint: 'task_started',
        tenantId,
        channelId: payload.channelId,
        threadTs: payload.threadTs,
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
      threadTs: payload.threadTs,
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
    if (payload.event?.type === 'message' && payload.event.threadTs && payload.event.channelId && payload.event.text && !payload.event.botId) {
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
          text: payload.event.text
        });
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
