import type { IntegrationIssueRef } from '../interfaces';
import type { CreateTaskInput } from '../../../ui/domain/api';
import { badRequest } from '../../http/errors';
import { handleError, json } from '../../http/response';
import * as tenantAuthDb from '../../tenant-auth-db';
import { createJiraIssueSourceIntegrationFromEnv } from '../jira/client';
import { scheduleRunJob } from '../../run-orchestrator';
import {
  parseSlackEventBody,
  parseSlackInteractionBody,
  parseSlackSlashCommandBody,
  type ParsedSlackInteraction
} from './payload';
import { resolveThreadTenant, verifySlackRequest } from './verification';
import { mirrorRunLifecycleMilestone } from './timeline';

const DEFAULT_TASK_ID_PREFIX = 'issue';
const DEFAULT_REVIEW_ROUND = 0;
const BOARD_OBJECT_NAME = 'agentboard';
const SOURCE_REF = 'main';
const JIRA_LLM_ADAPTER: CreateTaskInput['llmAdapter'] = 'codex';
const JIRA_LLM_MODEL: CreateTaskInput['codexModel'] = 'gpt-5.3-codex-spark';
const JIRA_LLM_REASONING_EFFORT: CreateTaskInput['codexReasoningEffort'] = 'high';
const FALLBACK_DISAMBIGUATION_WARNING = 'No matching repository was auto-selected for this issue.';
const DISAMBIGUATION_MULTIPLE_MAPPINGS_MESSAGE = 'Multiple repositories are mapped for Jira project';
const DISAMBIGUATION_NO_MAPPING_MESSAGE = 'No active mapping exists for project';

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
    return tenantAuthDb.upsertSlackThreadBinding(env, {
      tenantId,
      taskId: interaction.taskId,
      channelId: interaction.channelId,
      threadTs: interaction.threadTs,
      currentRunId,
      latestReviewRound: latestReviewRound + 1
    });
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

async function runSlackCommandAsync(
  env: Env,
  payload: ReturnType<typeof parseSlackSlashCommandBody>,
  ctx?: ExecutionContext<unknown>
) {
  const tenantId = await resolveThreadTenantId(env, payload.teamId);
  const bindingTaskId = payload.threadTs
    ? await createThreadBindingForSlashCommand(env, tenantId, payload.issueKey, payload.channelId, payload.threadTs)
    : buildTaskIdFromIssue(payload.issueKey);

  try {
    const issue = await resolveTenantAndJiraIssue(env, tenantId, payload.issueKey);
    await processJiraIssueFlow(env, ctx, tenantId, issue, {
      taskId: bindingTaskId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      latestReviewRound: DEFAULT_REVIEW_ROUND
    }, payload.responseUrl);
  } catch (error) {
    await postSlackResponse(payload.responseUrl, {
      response_type: 'ephemeral',
      text: `Failed to process /kanvy command for ${payload.issueKey}: ${toReadableErrorMessage(error)}`
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
      text: `Accepted /kanvy command for ${payload.issueKey}.`
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
    if (interaction.actionId === 'repo_disambiguation') {
      return handleRepoDisambiguationAction(env, ctx, tenantId, interaction);
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
