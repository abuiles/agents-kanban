import { badRequest } from '../../http/errors';

type SlackSlashCommandPayloadBase = {
  command: string;
  text: string;
  teamId: string | undefined;
  channelId: string;
  threadTs: string | undefined;
  userId: string;
  responseUrl: string | undefined;
};

export type SlackSlashCommandPayload = SlackSlashCommandPayloadBase;

export type SlackInteractionAction = 'repo_disambiguation' | 'approve_rerun' | 'pause' | 'close';

export type SlackInteractionValue = {
  tenantId?: string;
  taskId?: string;
  channelId?: string;
  threadTs?: string;
  currentRunId?: string;
  latestReviewRound?: number;
  repoId?: string;
  issueKey?: string;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
};

export type ParsedSlackInteraction = {
  actionId: SlackInteractionAction;
  teamId: string | undefined;
  tenantId: string | undefined;
  taskId: string;
  channelId: string;
  threadTs: string;
  currentRunId?: string;
  latestReviewRound?: number;
  repoId?: string;
  issueKey?: string;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
};

type SlackEventPayload = {
  type: string;
  challenge?: string;
  eventId?: string;
  teamId?: string;
  event?: {
    type?: string;
    channelId?: string;
    threadTs?: string;
    text?: string;
    userId?: string;
    botId?: string;
    ts?: string;
  };
};

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/i;
const SUPPORTED_SLACK_COMMAND = '/kanvy';
const SUPPORTED_ACTION_IDS: Set<string> = new Set([
  'repo_disambiguation',
  'approve_rerun',
  'pause',
  'close'
]);

function readFormValue(params: URLSearchParams, key: string, required: true): string;
function readFormValue(params: URLSearchParams, key: string, required: false): string | undefined;
function readFormValue(params: URLSearchParams, key: string, required: boolean): string | undefined {
  const value = params.get(key)?.trim();
  if (required && !value) {
    throw badRequest(`Missing Slack payload field ${key}.`);
  }
  return value;
}

function parseInteractionValue(raw: string | undefined): SlackInteractionValue {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as SlackInteractionValue;
    }
  } catch {
    throw badRequest('Invalid Slack interaction action value.');
  }
  throw badRequest('Invalid Slack interaction action value.');
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  throw badRequest(`Invalid Slack interaction value ${field}.`);
}

function readOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw badRequest(`Invalid Slack interaction value ${field}.`);
    }
    return parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  throw badRequest(`Invalid Slack interaction value ${field}.`);
}

export function parseSlackSlashCommandBody(rawBody: string): SlackSlashCommandPayload {
  const params = new URLSearchParams(rawBody);
  const command = readFormValue(params, 'command', true);
  if (!command || command.toLowerCase() !== SUPPORTED_SLACK_COMMAND) {
    throw badRequest('Unknown Slack slash command.');
  }
  const text = readFormValue(params, 'text', false) ?? '';

  return {
    command,
    text,
    teamId: readFormValue(params, 'team_id', false),
    channelId: readFormValue(params, 'channel_id', true),
    threadTs: readFormValue(params, 'thread_ts', false),
    userId: readFormValue(params, 'user_id', false) ?? 'unknown',
    responseUrl: readFormValue(params, 'response_url', false)
  };
}

export function parseSlackInteractionBody(rawBody: string): ParsedSlackInteraction {
  const params = new URLSearchParams(rawBody);
  const payloadRaw = params.get('payload');
  if (!payloadRaw) {
    throw badRequest('Invalid Slack interaction payload.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    throw badRequest('Invalid Slack interaction payload.');
  }
  if (payload.type !== 'block_actions') {
    throw badRequest('Unsupported Slack interaction type.');
  }
  const actions = payload.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw badRequest('Slack interaction payload is missing actions.');
  }
  const firstAction = actions[0];
  if (!firstAction || typeof firstAction !== 'object') {
    throw badRequest('Slack interaction action payload is malformed.');
  }
  const actionIdRaw = (firstAction as Record<string, unknown>).action_id;
  if (typeof actionIdRaw !== 'string' || !SUPPORTED_ACTION_IDS.has(actionIdRaw)) {
    throw badRequest('Unsupported Slack interaction action.');
  }
  const actionId = actionIdRaw as SlackInteractionAction;

  const value = parseInteractionValue((firstAction as Record<string, unknown>).value as string | undefined);
  const container = payload.container as Record<string, unknown> | undefined;
  const team = payload.team as Record<string, unknown> | undefined;
  const tenantId = (value.tenantId ?? undefined) as string | undefined;

  return {
    actionId,
    teamId: typeof team?.id === 'string' && team.id.trim() ? team.id.trim() : undefined,
    tenantId,
    taskId: typeof value.taskId === 'string' && value.taskId.trim()
      ? value.taskId.trim()
      : typeof payload.callback_id === 'string' && payload.callback_id.trim()
        ? payload.callback_id.trim()
        : undefined!,
    channelId: typeof value.channelId === 'string' && value.channelId.trim()
      ? value.channelId.trim()
      : typeof (container?.channel_id) === 'string' && container?.channel_id.trim()
        ? String(container.channel_id).trim()
        : (() => { throw badRequest('Missing Slack interaction channel id.'); })(),
    threadTs: typeof value.threadTs === 'string' && value.threadTs.trim()
      ? value.threadTs.trim()
      : typeof (container?.thread_ts) === 'string' && container?.thread_ts.trim()
        ? String(container.thread_ts).trim()
        : '',
    currentRunId: typeof value.currentRunId === 'string' && value.currentRunId.trim() ? value.currentRunId.trim() : undefined,
    latestReviewRound: readOptionalNumber(value.latestReviewRound, 'latestReviewRound'),
    repoId: readOptionalString(value.repoId, 'repoId'),
    issueKey: readOptionalString(value.issueKey, 'issueKey'),
    issueTitle: readOptionalString(value.issueTitle, 'issueTitle'),
    issueBody: readOptionalString(value.issueBody, 'issueBody'),
    issueUrl: readOptionalString(value.issueUrl, 'issueUrl')
  };
}

export function parseSlackEventBody(rawBody: string): SlackEventPayload {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw badRequest('Invalid Slack event payload.');
  }
  if (!payload || typeof payload.type !== 'string') {
    throw badRequest('Invalid Slack event payload.');
  }
  return {
    type: payload.type,
    challenge: typeof payload.challenge === 'string' ? payload.challenge : undefined,
    eventId: typeof payload.event_id === 'string' && payload.event_id.trim() ? payload.event_id.trim() : undefined,
    teamId: (() => {
      const event = payload as Record<string, unknown>;
      if (typeof event.team_id === 'string' && event.team_id.trim()) {
        return event.team_id.trim();
      }
      const team = event.team as Record<string, unknown> | undefined;
      return typeof team?.id === 'string' && team.id.trim() ? team.id.trim() : undefined;
    })(),
    event: (() => {
      const event = payload.event as Record<string, unknown> | undefined;
      if (!event || typeof event !== 'object') {
        return undefined;
      }
      const read = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
      return {
        type: read(event.type),
        channelId: read(event.channel),
        threadTs: read(event.thread_ts),
        text: read(event.text),
        userId: read(event.user),
        botId: read(event.bot_id),
        ts: read(event.ts)
      };
    })()
  };
}

export function parseJiraFastPathIssueKey(text: string): string | undefined {
  const match = /^fix\s+([A-Z][A-Z0-9_]*-\d+)\s*$/i.exec(text.trim());
  if (!match?.[1]) {
    return undefined;
  }
  const issueKey = match[1].toUpperCase();
  return ISSUE_KEY_PATTERN.test(issueKey) ? issueKey : undefined;
}
