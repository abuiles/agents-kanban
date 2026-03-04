import type { IntegrationConfig, IntegrationConfigSettings, SlackThreadBinding } from '../../../ui/domain/types';
import { resolveIntegrationConfig } from '../config-resolution';
import * as tenantAuthDb from '../../tenant-auth-db';

const DEFAULT_BOT_TOKEN_SECRET_KEY = 'slack/bot-token';
const TENANT_BOT_TOKEN_SECRET_PREFIX = 'slack/bot-token';

function readSettingString(settings: IntegrationConfigSettings, key: string) {
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function resolveSlackBotToken(env: Env, config: IntegrationConfig | undefined, tenantId: string) {
  const tokenFromSettings = config
    ? readSettingString(config.settings, 'botToken') ?? readSettingString(config.settings, 'token')
    : undefined;
  if (tokenFromSettings) {
    return tokenFromSettings;
  }

  if (config?.secretRef?.trim()) {
    const value = await env.SECRETS_KV.get(config.secretRef.trim());
    if (value?.trim()) {
      return value.trim();
    }
  }

  const tenantScoped = await env.SECRETS_KV.get(`${TENANT_BOT_TOKEN_SECRET_PREFIX}:${tenantId}`);
  if (tenantScoped?.trim()) {
    return tenantScoped.trim();
  }

  const fallback = await env.SECRETS_KV.get(DEFAULT_BOT_TOKEN_SECRET_KEY);
  return fallback?.trim() || undefined;
}

async function resolveSlackConfig(env: Env, target: { tenantId: string; repoId?: string; channelId: string }) {
  const configs = await tenantAuthDb.listIntegrationConfigs(env, target.tenantId, {
    pluginKind: 'slack',
    enabledOnly: true
  });

  return resolveIntegrationConfig(configs, {
    tenantId: target.tenantId,
    pluginKind: 'slack',
    repoId: target.repoId,
    channelId: target.channelId
  });
}

export async function listSlackThreadBindingsForTask(env: Env, tenantId: string, taskId: string): Promise<SlackThreadBinding[]> {
  return tenantAuthDb.listSlackThreadBindings(env, tenantId, { taskId });
}

export async function postSlackThreadMessage(
  env: Env,
  target: {
    tenantId: string;
    repoId?: string;
    channelId: string;
    threadTs?: string;
    text: string;
  }
): Promise<{ delivered: boolean; reason?: string; messageTs?: string }> {
  const config = await resolveSlackConfig(env, target);
  const token = await resolveSlackBotToken(env, config, target.tenantId);
  if (!token) {
    return { delivered: false, reason: 'missing_slack_bot_token' };
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      channel: target.channelId,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      text: target.text,
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn: true
    })
  });

  if (!response.ok) {
    return { delivered: false, reason: `slack_http_${response.status}` };
  }

  const payload = await response.json().catch(() => undefined) as {
    ok?: boolean;
    ts?: string;
    message?: { ts?: string };
  } | undefined;
  if (payload?.ok !== true) {
    return { delivered: false, reason: 'slack_api_error' };
  }

  return {
    delivered: true,
    messageTs: payload.ts ?? payload.message?.ts
  };
}

export async function postSlackChannelMessage(
  env: Env,
  target: {
    tenantId: string;
    repoId?: string;
    channelId: string;
    text: string;
  }
): Promise<{ delivered: boolean; reason?: string; ts?: string }> {
  const config = await resolveSlackConfig(env, target);
  const token = await resolveSlackBotToken(env, config, target.tenantId);
  if (!token) {
    return { delivered: false, reason: 'missing_slack_bot_token' };
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      channel: target.channelId,
      text: target.text,
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn: true
    })
  });

  if (!response.ok) {
    return { delivered: false, reason: `slack_http_${response.status}` };
  }

  const payload = await response.json().catch(() => undefined) as { ok?: boolean; ts?: unknown } | undefined;
  if (payload?.ok !== true) {
    return { delivered: false, reason: 'slack_api_error' };
  }

  return {
    delivered: true,
    ts: typeof payload.ts === 'string' && payload.ts.trim() ? payload.ts.trim() : undefined
  };
}
