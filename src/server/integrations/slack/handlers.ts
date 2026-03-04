import { badRequest } from '../../http/errors';
import { handleError, json } from '../../http/response';
import * as tenantAuthDb from '../tenant-auth-db';
import {
  parseSlackEventBody,
  parseSlackInteractionBody,
  parseSlackSlashCommandBody,
  type ParsedSlackInteraction
} from './payload';
import { resolveThreadTenant, verifySlackRequest } from './verification';

const DEFAULT_TASK_ID_PREFIX = 'issue';
const DEFAULT_REVIEW_ROUND = 0;

function buildTaskIdFromIssue(issueKey: string) {
  return `${DEFAULT_TASK_ID_PREFIX}:${issueKey}`;
}

function normalizeLatestReviewRound(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : DEFAULT_REVIEW_ROUND;
}

async function createThreadBindingForSlashCommand(
  env: Env,
  tenantId: string,
  commandIssueKey: string,
  channelId: string,
  threadTs: string
) {
  const taskId = buildTaskIdFromIssue(commandIssueKey);
  return tenantAuthDb.upsertSlackThreadBinding(env, {
    tenantId,
    taskId,
    channelId,
    threadTs,
    latestReviewRound: DEFAULT_REVIEW_ROUND
  });
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

async function runSlackCommandAsync(env: Env, payload: ReturnType<typeof parseSlackSlashCommandBody>) {
  const tenantId = await resolveThreadTenantId(env, payload.teamId);
  if (!payload.threadTs) {
    return;
  }
  await createThreadBindingForSlashCommand(env, tenantId, payload.issueKey, payload.channelId, payload.threadTs);
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
    const job = runSlackCommandAsync(env, payload);
    if (ctx?.waitUntil) {
      // Keep ack path fast and defer persistence to platform context.
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

export async function handleSlackInteractions(request: Request, env: Env): Promise<Response> {
  try {
    const rawBody = await request.text();
    await verifySlackRequest(env, request, rawBody);
    const interaction = parseSlackInteractionBody(rawBody);
    const tenantId = await resolveThreadTenantId(env, interaction.tenantId || interaction.teamId);
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
