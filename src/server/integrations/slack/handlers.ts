import type { IntegrationIssueRef } from '../interfaces';
import type { CreateTaskInput } from '../../../ui/domain/api';
import { badRequest } from '../../http/errors';
import { handleError, json } from '../../http/response';
import * as tenantAuthDb from '../../tenant-auth-db';
import { createJiraIssueSourceIntegrationFromEnv } from '../jira/client';
import { scheduleRunJob } from '../../run-orchestrator';
import { buildIdempotencyKey } from '../idempotency';
import { resolveIntegrationConfig } from '../config-resolution';
import {
  parseSlackEventBody,
  parseSlackInteractionBody,
  parseSlackSlashCommandBody,
  type ParsedSlackInteraction
} from './payload';
import { resolveThreadTenant, verifySlackRequest } from './verification';
import { mirrorRunLifecycleMilestone } from './timeline';
import { postSlackThreadMessage } from './client';
import {
  buildClarificationQuestion,
  buildSlackIntakeSessionKey,
  defaultSlackIntentSettings,
  getSlackIntakeSession,
  isIntentComplete,
  mergeIntentState,
  parseSlackIntentText,
  putSlackIntakeSession,
  type SlackIntakeSession,
  type SlackIntentSettings
} from './intent';

const DEFAULT_TASK_ID_PREFIX = 'issue';
const DEFAULT_REVIEW_ROUND = 0;
const BOARD_OBJECT_NAME = 'agentboard';
const SOURCE_REF = 'main';
const JIRA_LLM_ADAPTER: CreateTaskInput['llmAdapter'] = 'codex';
const JIRA_LLM_MODEL: CreateTaskInput['codexModel'] = 'gpt-5.1-codex-mini';
const JIRA_LLM_REASONING_EFFORT: CreateTaskInput['codexReasoningEffort'] = 'high';
const INTAKE_TASK_ID_PREFIX = 'slack-intake';
const DEFAULT_INTAKE_TASK_MODEL: CreateTaskInput['codexModel'] = 'gpt-5.1-codex-mini';
const DEFAULT_INTAKE_TASK_REASONING: CreateTaskInput['codexReasoningEffort'] = 'medium';
const FALLBACK_DISAMBIGUATION_WARNING = 'No matching repository was auto-selected for this issue.';
const DISAMBIGUATION_MULTIPLE_MAPPINGS_MESSAGE = 'Multiple repositories are mapped for Jira project';
const DISAMBIGUATION_NO_MAPPING_MESSAGE = 'No active mapping exists for project';
const INGRESS_DEDUPE_TTL_SECONDS = 10 * 60;

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

function buildTaskPromptFromIssue(issue: IntegrationIssueRef) {
  return `Fix Jira issue ${issue.issueKey}: ${issue.title}\n\n${issue.body}`.trim();
}

function buildTaskPayloadFromIssue(issue: IntegrationIssueRef, repoId: string): CreateTaskInput {
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
    codexModel: JIRA_LLM_MODEL,
    codexReasoningEffort: JIRA_LLM_REASONING_EFFORT
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

function normalizeSettingBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeSettingString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSettingReasoning(value: unknown, fallback: SlackIntentSettings['intentReasoningEffort']) {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return fallback;
}

function normalizeSettingTurns(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(8, Math.trunc(value)));
}

function buildIntakeTaskId(channelId: string, threadTs: string) {
  return `${INTAKE_TASK_ID_PREFIX}:${channelId}:${threadTs}`;
}

async function resolveSlackIntentSettings(
  env: Env,
  tenantId: string,
  target: { channelId?: string; repoId?: string }
): Promise<SlackIntentSettings> {
  const defaults = defaultSlackIntentSettings();
  const configs = await tenantAuthDb.listIntegrationConfigs(env, tenantId, {
    pluginKind: 'slack',
    enabledOnly: true
  });
  const config = resolveIntegrationConfig(configs, {
    tenantId,
    pluginKind: 'slack',
    channelId: target.channelId,
    repoId: target.repoId
  });
  if (!config) {
    return defaults;
  }
  return {
    intentEnabled: normalizeSettingBoolean(config.settings.intentEnabled, defaults.intentEnabled),
    intentModel: normalizeSettingString(config.settings.intentModel) ?? defaults.intentModel,
    intentReasoningEffort: normalizeSettingReasoning(config.settings.intentReasoningEffort, defaults.intentReasoningEffort),
    intentAutoCreate: normalizeSettingBoolean(config.settings.intentAutoCreate, defaults.intentAutoCreate),
    intentClarifyMaxTurns: normalizeSettingTurns(config.settings.intentClarifyMaxTurns, defaults.intentClarifyMaxTurns),
    defaultRepoId: normalizeSettingString(config.settings.defaultRepoId)
  };
}

function normalizeIntakeCodexModel(model: string | undefined): CreateTaskInput['codexModel'] {
  if (model === 'gpt-5.3-codex' || model === 'gpt-5.3-codex-spark' || model === 'gpt-5.1-codex-mini') {
    return model;
  }
  return DEFAULT_INTAKE_TASK_MODEL;
}

async function listTenantRepoCandidates(env: Env, tenantId: string): Promise<RepoDisambiguationChoice[]> {
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

function resolveRepoFromHint(options: RepoDisambiguationChoice[], hint: string | undefined): RepoDisambiguationChoice | undefined {
  if (!hint) {
    return undefined;
  }
  const lowered = hint.toLowerCase();
  return options.find((option) => option.repoId.toLowerCase() === lowered || option.label.toLowerCase().includes(lowered));
}

function buildIntentRepoChoiceValue(value: {
  tenantId: string;
  channelId: string;
  threadTs: string;
  sessionKey: string;
  repoId: string;
  taskId: string;
}) {
  return JSON.stringify(value);
}

function buildIntentRepoDisambiguationResponse(message: string, options: RepoDisambiguationChoice[], context: {
  tenantId: string;
  channelId: string;
  threadTs: string;
  sessionKey: string;
  taskId: string;
}) {
  return {
    response_type: 'ephemeral' as const,
    replace_original: false,
    text: message,
    blocks: [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: message }
      },
      {
        type: 'actions' as const,
        elements: options.map((option) => ({
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: option.label },
          action_id: 'intent_repo_select',
          value: buildIntentRepoChoiceValue({
            tenantId: context.tenantId,
            channelId: context.channelId,
            threadTs: context.threadTs,
            sessionKey: context.sessionKey,
            repoId: option.repoId,
            taskId: context.taskId
          })
        }))
      }
    ]
  };
}

function buildTaskPayloadFromIntent(
  repoId: string,
  intent: {
    taskTitle?: string;
    taskPrompt?: string;
    acceptanceCriteria: string[];
  },
  settings: SlackIntentSettings
): CreateTaskInput {
  return {
    repoId,
    title: (intent.taskTitle || 'Slack intake task').trim(),
    description: intent.taskPrompt,
    sourceRef: SOURCE_REF,
    taskPrompt: intent.taskPrompt || intent.taskTitle || 'Slack intake task',
    acceptanceCriteria: intent.acceptanceCriteria.length > 0
      ? intent.acceptanceCriteria
      : ['Complete the requested Slack intake change.'],
    context: {
      links: [],
      notes: 'Created from Slack free-text intake.'
    },
    llmAdapter: JIRA_LLM_ADAPTER,
    codexModel: normalizeIntakeCodexModel(settings.intentModel),
    codexReasoningEffort: DEFAULT_INTAKE_TASK_REASONING
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
  responseUrl: string | undefined
) {
  const issueProjectKey = issueProjectKeyFromIssue(issue.issueKey);
  const mappings = await tenantAuthDb.listJiraProjectRepoMappingsByProject(env, tenantId, issueProjectKey, true);
  if (mappings.length === 0) {
    const candidates = await resolveRepoCandidates(env, tenantId, issueProjectKey, []);
    if (candidates.length === 0) {
      await postSlackResponse(responseUrl, buildNoMappingResponse(issue, issueProjectKey));
      return;
    }
    await postSlackResponse(responseUrl, buildDisambiguationResponse(
      issue,
      issueProjectKey,
      candidates,
      tenantId,
      true,
      { taskId: bindings.taskId, channelId: bindings.channelId, threadTs: bindings.threadTs ?? '' }
    ));
    return;
  }

  const candidates = await resolveRepoCandidates(env, tenantId, issueProjectKey, mappings);
  if (mappings.length > 1) {
    if (candidates.length === 0) {
      await postSlackResponse(responseUrl, buildNoMappingResponse(issue, issueProjectKey));
      return;
    }
    await postSlackResponse(responseUrl, buildDisambiguationResponse(
      issue,
      issueProjectKey,
      candidates,
      tenantId,
      false,
      { taskId: bindings.taskId, channelId: bindings.channelId, threadTs: bindings.threadTs ?? '' }
    ));
    return;
  }

  if (candidates.length !== 1) {
    await postSlackResponse(responseUrl, buildNoMappingResponse(issue, issueProjectKey));
    return;
  }

  const repoId = candidates[0]!.repoId;
  const payload = buildTaskPayloadFromIssue(issue, repoId);
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

async function resolveRepoForIntent(
  env: Env,
  tenantId: string,
  options: {
    explicitRepoId?: string;
    repoHint?: string;
    defaultRepoId?: string;
  }
) {
  const candidates = await listTenantRepoCandidates(env, tenantId);
  const directRepoId = options.explicitRepoId?.trim();
  if (directRepoId) {
    return { repoId: directRepoId, candidates };
  }
  const defaultRepoId = options.defaultRepoId?.trim();
  if (defaultRepoId) {
    return { repoId: defaultRepoId, candidates };
  }
  const hinted = resolveRepoFromHint(candidates, options.repoHint);
  if (hinted) {
    return { repoId: hinted.repoId, candidates };
  }
  if (candidates.length === 1) {
    return { repoId: candidates[0]!.repoId, candidates };
  }
  return { repoId: undefined, candidates };
}

async function postThreadMessage(
  env: Env,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    repoId?: string;
    text: string;
  }
) {
  await postSlackThreadMessage(env, {
    tenantId: input.tenantId,
    repoId: input.repoId ?? 'repo_unknown',
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: input.text
  }).catch(() => {});
}

async function attemptCreateTaskFromIntakeSession(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  session: SlackIntakeSession,
  settings: SlackIntentSettings,
  responseUrl?: string
) {
  const resolution = await resolveRepoForIntent(env, session.tenantId, {
    explicitRepoId: session.parse.repoId,
    repoHint: session.parse.repoHint,
    defaultRepoId: settings.defaultRepoId
  });
  if (!resolution.repoId) {
    const question = resolution.candidates.length > 1
      ? 'I found multiple repositories. Pick one to continue.'
      : 'I could not resolve a repository. Reply with the repository slug or repoId.';
    if (responseUrl && resolution.candidates.length > 1) {
      await postSlackResponse(
        responseUrl,
        buildIntentRepoDisambiguationResponse(question, resolution.candidates, {
          tenantId: session.tenantId,
          channelId: session.channelId,
          threadTs: session.threadTs,
          sessionKey: session.key,
          taskId: buildIntakeTaskId(session.channelId, session.threadTs)
        })
      );
    } else {
      await postThreadMessage(env, {
        tenantId: session.tenantId,
        channelId: session.channelId,
        threadTs: session.threadTs,
        text: question
      });
    }
    return;
  }

  const payload = buildTaskPayloadFromIntent(resolution.repoId, session.parse, settings);
  const started = await startRunForTask(env, ctx, session.tenantId, resolution.repoId, payload);
  await tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId: session.tenantId,
    taskId: started.taskId,
    channelId: session.channelId,
    threadTs: session.threadTs,
    currentRunId: started.runId,
    latestReviewRound: 0
  });
  session.status = 'completed';
  session.updatedAt = new Date().toISOString();
  await putSlackIntakeSession(env, session);
  const text = `Started task ${started.taskId} and run ${started.runId} for your request in repo ${resolution.repoId}.`;
  if (responseUrl) {
    await postSlackResponse(responseUrl, { response_type: 'ephemeral', text });
  } else {
    await postThreadMessage(env, {
      tenantId: session.tenantId,
      channelId: session.channelId,
      threadTs: session.threadTs,
      repoId: resolution.repoId,
      text
    });
  }
}

async function processSlackIntentMessage(
  env: Env,
  ctx: ExecutionContext<unknown> | undefined,
  input: {
    tenantId: string;
    channelId: string;
    threadTs: string;
    text: string;
    responseUrl?: string;
    existingSession?: SlackIntakeSession;
  }
) {
  const settings = await resolveSlackIntentSettings(env, input.tenantId, { channelId: input.channelId });
  if (!settings.intentEnabled) {
    if (input.responseUrl) {
      await postSlackResponse(input.responseUrl, {
        response_type: 'ephemeral',
        text: 'Slack free-text intake is disabled for this scope.'
      });
    }
    return;
  }

  const parse = await parseSlackIntentText(env, input.text, settings);
  const sessionKey = buildSlackIntakeSessionKey(input.tenantId, input.channelId, input.threadTs);
  const now = new Date().toISOString();
  const session: SlackIntakeSession = input.existingSession
    ? {
      ...input.existingSession,
      parse: mergeIntentState(input.existingSession.parse, parse),
      turnCount: input.existingSession.turnCount + 1,
      updatedAt: now,
      lastUserMessage: input.text
    }
    : {
      key: sessionKey,
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: 'active',
      turnCount: 0,
      maxTurns: settings.intentClarifyMaxTurns,
      updatedAt: now,
      createdAt: now,
      lastUserMessage: input.text,
      parse
    };

  if (session.parse.intent === 'create_task' && settings.intentAutoCreate && isIntentComplete(session.parse)) {
    await attemptCreateTaskFromIntakeSession(env, ctx, session, settings, input.responseUrl);
    return;
  }

  if (session.turnCount >= session.maxTurns) {
    session.status = 'handoff';
    await putSlackIntakeSession(env, session);
    const handoff = 'I still need more detail. Please provide: repository, objective, and acceptance criteria in one message.';
    if (input.responseUrl) {
      await postSlackResponse(input.responseUrl, { response_type: 'ephemeral', text: handoff });
    } else {
      await postThreadMessage(env, {
        tenantId: input.tenantId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: handoff
      });
    }
    return;
  }

  session.status = 'active';
  await putSlackIntakeSession(env, session);
  const question = buildClarificationQuestion(session.parse);
  if (input.responseUrl) {
    await postSlackResponse(input.responseUrl, {
      response_type: 'ephemeral',
      text: question
    });
  } else {
    await postThreadMessage(env, {
      tenantId: input.tenantId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: question
    });
  }
}

async function runSlackCommandAsync(
  env: Env,
  payload: ReturnType<typeof parseSlackSlashCommandBody>,
  ctx?: ExecutionContext<unknown>
) {
  const tenantId = await resolveThreadTenantId(env, payload.teamId);
  const threadTs = payload.threadTs?.trim() || `${Date.now() / 1000}`;
  const fastPathIssueKey = payload.issueKey?.trim();
  const slashDedupeKey = buildIdempotencyKey({
    provider: 'slack',
    tenantId,
    eventType: fastPathIssueKey ? 'slash_command.fix' : 'slash_command.intent',
    providerEventId: payload.responseUrl ?? `${payload.teamId ?? 'team:default'}:${payload.channelId}:${payload.text}`,
    subjectId: `${payload.channelId}:${threadTs}`,
    metadata: {
      issueKey: fastPathIssueKey,
      userId: payload.userId
    }
  });
  if (!(await markIngressDeliveryIfNew(env, slashDedupeKey))) {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: `Duplicate /kanvy command ignored${fastPathIssueKey ? ` for ${fastPathIssueKey}` : ''}.`
    });
    return;
  }
  if (!fastPathIssueKey) {
    await processSlackIntentMessage(env, ctx, {
      tenantId,
      channelId: payload.channelId,
      threadTs,
      text: payload.text.trim(),
      responseUrl: payload.responseUrl
    });
    return;
  }
  const bindingTaskId = payload.threadTs
    ? await createThreadBindingForSlashCommand(env, tenantId, fastPathIssueKey, payload.channelId, payload.threadTs)
    : buildTaskIdFromIssue(fastPathIssueKey);

  try {
    const issue = await resolveTenantAndJiraIssue(env, tenantId, fastPathIssueKey);
    await processJiraIssueFlow(env, ctx, tenantId, issue, {
      taskId: bindingTaskId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      latestReviewRound: DEFAULT_REVIEW_ROUND
    }, payload.responseUrl);
  } catch (error) {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: `Failed to process /kanvy command for ${fastPathIssueKey}: ${toReadableErrorMessage(error)}`
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
      text: payload.issueKey
        ? `Accepted /kanvy command for ${payload.issueKey}.`
        : 'Accepted /kanvy free-text intake command.'
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
    if (payload.type === 'event_callback' && payload.eventType === 'message') {
      const tenantId = await resolveThreadTenantId(env, payload.teamId);
      const channelId = payload.channelId?.trim();
      const threadTs = payload.threadTs?.trim();
      const text = payload.text?.trim();
      if (channelId && threadTs && text && !payload.botId) {
        const eventDedupeKey = buildIdempotencyKey({
          provider: 'slack',
          tenantId,
          eventType: 'event.message',
          providerEventId: payload.eventId ?? `${channelId}:${threadTs}:${text}`,
          subjectId: `${channelId}:${threadTs}`,
          metadata: { userId: payload.userId ?? 'unknown' }
        });
        if (await markIngressDeliveryIfNew(env, eventDedupeKey)) {
          const sessionKey = buildSlackIntakeSessionKey(tenantId, channelId, threadTs);
          const session = await getSlackIntakeSession(env, sessionKey);
          if (session?.status === 'active') {
            if (text.toLowerCase() === 'cancel') {
              session.status = 'cancelled';
              session.updatedAt = new Date().toISOString();
              await putSlackIntakeSession(env, session);
              await postThreadMessage(env, {
                tenantId,
                channelId,
                threadTs,
                text: 'Slack intake cancelled for this thread.'
              });
            } else {
              await processSlackIntentMessage(env, undefined, {
                tenantId,
                channelId,
                threadTs,
                text,
                existingSession: session
              });
            }
          }
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
      providerEventId: `${interaction.actionId}:${interaction.currentRunId ?? interaction.issueKey ?? interaction.taskId ?? interaction.sessionKey ?? interaction.repoId ?? 'unknown'}`,
      subjectId: `${interaction.channelId}:${interaction.threadTs || 'root'}`,
      metadata: {
        taskId: interaction.taskId || null,
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
    if (interaction.actionId === 'intent_repo_select') {
      const sessionKey = interaction.sessionKey
        || buildSlackIntakeSessionKey(tenantId, interaction.channelId, interaction.threadTs);
      const session = await getSlackIntakeSession(env, sessionKey);
      if (!session || session.status !== 'active') {
        return json({ ok: true, status: 'intake_session_missing', action: interaction.actionId });
      }
      session.parse.repoId = interaction.repoId ?? session.parse.repoId;
      session.updatedAt = new Date().toISOString();
      await putSlackIntakeSession(env, session);
      const settings = await resolveSlackIntentSettings(env, tenantId, {
        channelId: interaction.channelId,
        repoId: session.parse.repoId
      });
      await attemptCreateTaskFromIntakeSession(env, ctx, session, settings);
      return json({
        ok: true,
        action: interaction.actionId,
        taskId: interaction.taskId || buildIntakeTaskId(interaction.channelId, interaction.threadTs)
      });
    }
    if (interaction.actionId === 'intent_cancel') {
      const sessionKey = interaction.sessionKey
        || buildSlackIntakeSessionKey(tenantId, interaction.channelId, interaction.threadTs);
      const session = await getSlackIntakeSession(env, sessionKey);
      if (session) {
        session.status = 'cancelled';
        session.updatedAt = new Date().toISOString();
        await putSlackIntakeSession(env, session);
      }
      return json({
        ok: true,
        action: interaction.actionId,
        status: 'cancelled'
      });
    }
    if (interaction.actionId === 'intent_confirm_create') {
      return json({
        ok: true,
        action: interaction.actionId,
        status: 'noop'
      });
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
