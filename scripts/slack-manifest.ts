#!/usr/bin/env node

type Mode = 'render' | 'create' | 'update';

type CliOptions = {
  mode: Mode;
  baseUrl: string;
  appId?: string;
  appConfigToken?: string;
  appName: string;
  slashCommand: string;
  botDisplayName: string;
  description: string;
  backgroundColor: string;
};

type SlackApiSuccess<T = Record<string, unknown>> = {
  ok: true;
} & T;

type SlackApiFailure = {
  ok: false;
  error?: string;
};

type SlackApiResponse<T = Record<string, unknown>> = SlackApiSuccess<T> | SlackApiFailure;

function usage() {
  process.stdout.write(
    [
      'Usage:',
      '  yarn slack:manifest -- [--render|--create|--update] [--base-url <url>] [--app-id <A...>] [--token <xoxp/xapp...>]',
      '',
      'Defaults:',
      '  --mode render',
      '  --base-url from AK_DEV_PUBLIC_URL',
      '  --token from SLACK_APP_CONFIG_TOKEN or SLACK_MANIFEST_TOKEN',
      '  --app-id from SLACK_APP_ID',
      '',
      'Examples:',
      '  yarn slack:manifest -- --render --base-url https://example.trycloudflare.com',
      '  yarn slack:manifest -- --update --base-url https://example.trycloudflare.com --app-id A123 --token xapp-***',
      '  SLACK_APP_CONFIG_TOKEN=xapp-*** SLACK_APP_ID=A123 AK_DEV_PUBLIC_URL=https://example.trycloudflare.com yarn slack:manifest -- --update'
    ].join('\n') + '\n'
  );
}

function parseArgs(argv: string[]): CliOptions {
  let mode: Mode = 'render';
  let baseUrl = process.env.AK_DEV_PUBLIC_URL?.trim() || '';
  let appId = process.env.SLACK_APP_ID?.trim();
  let appConfigToken = process.env.SLACK_APP_CONFIG_TOKEN?.trim() || process.env.SLACK_MANIFEST_TOKEN?.trim();
  let appName = process.env.SLACK_APP_NAME?.trim() || 'Agents Kanban';
  let slashCommand = process.env.SLACK_COMMAND?.trim() || '/kanvy';
  let botDisplayName = process.env.SLACK_BOT_DISPLAY_NAME?.trim() || 'kanvy';
  let description = process.env.SLACK_APP_DESCRIPTION?.trim() || 'Run agents from Slack using /kanvy.';
  let backgroundColor = process.env.SLACK_APP_BG_COLOR?.trim() || '#1D4ED8';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--render') {
      mode = 'render';
      continue;
    }
    if (arg === '--create') {
      mode = 'create';
      continue;
    }
    if (arg === '--update') {
      mode = 'update';
      continue;
    }
    if (arg === '--base-url') {
      baseUrl = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--app-id') {
      appId = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--token') {
      appConfigToken = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--app-name') {
      appName = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--slash-command') {
      slashCommand = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--bot-display-name') {
      botDisplayName = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--description') {
      description = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--background-color') {
      backgroundColor = (argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!baseUrl) {
    throw new Error('Missing base URL. Pass --base-url or set AK_DEV_PUBLIC_URL.');
  }
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalizedBaseUrl);
  } catch {
    throw new Error(`Invalid --base-url value: ${normalizedBaseUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Base URL must be https for Slack webhooks. Received: ${normalizedBaseUrl}`);
  }

  if (!slashCommand.startsWith('/')) {
    throw new Error(`Slash command must start with "/". Received: ${slashCommand}`);
  }

  if (mode === 'update' && !appId) {
    throw new Error('Missing app id for update mode. Pass --app-id or set SLACK_APP_ID.');
  }

  if ((mode === 'create' || mode === 'update') && !appConfigToken) {
    throw new Error('Missing Slack app config token. Pass --token or set SLACK_APP_CONFIG_TOKEN.');
  }

  return {
    mode,
    baseUrl: normalizedBaseUrl,
    appId: appId || undefined,
    appConfigToken: appConfigToken || undefined,
    appName,
    slashCommand,
    botDisplayName,
    description,
    backgroundColor
  };
}

function buildManifest(options: CliOptions) {
  return {
    display_information: {
      name: options.appName,
      description: options.description,
      background_color: options.backgroundColor
    },
    features: {
      bot_user: {
        display_name: options.botDisplayName,
        always_online: false
      },
      slash_commands: [
        {
          command: options.slashCommand,
          description: 'Run Agents Kanban tasks from Slack',
          url: `${options.baseUrl}/api/integrations/slack/commands`,
          should_escape: false
        }
      ]
    },
    oauth_config: {
      scopes: {
        bot: ['commands', 'chat:write']
      }
    },
    settings: {
      event_subscriptions: {
        request_url: `${options.baseUrl}/api/integrations/slack/events`,
        bot_events: []
      },
      interactivity: {
        is_enabled: true,
        request_url: `${options.baseUrl}/api/integrations/slack/interactions`
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false
    }
  };
}

async function callSlackApi(
  token: string,
  method: 'apps.manifest.create' | 'apps.manifest.update',
  body: Record<string, unknown>
) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Slack API ${method} failed with HTTP ${response.status}.`);
  }

  const payload = await response.json() as SlackApiResponse;
  if (!payload.ok) {
    throw new Error(`Slack API ${method} error: ${payload.error || 'unknown_error'}`);
  }
  return payload;
}

function printSummary(options: CliOptions) {
  process.stdout.write(
    [
      'Slack manifest endpoints:',
      `- slash command: ${options.baseUrl}/api/integrations/slack/commands`,
      `- interactions: ${options.baseUrl}/api/integrations/slack/interactions`,
      `- events: ${options.baseUrl}/api/integrations/slack/events`,
      '',
      'Scopes:',
      '- commands',
      '- chat:write'
    ].join('\n') + '\n'
  );
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = buildManifest(options);

  if (options.mode === 'render') {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    printSummary(options);
    return;
  }

  const token = options.appConfigToken!;
  if (options.mode === 'create') {
    const payload = await callSlackApi(token, 'apps.manifest.create', { manifest });
    process.stdout.write('Slack app created from manifest.\n');
    const appId = (payload as Record<string, unknown>).app_id;
    if (typeof appId === 'string' && appId.trim()) {
      process.stdout.write(`- app_id: ${appId}\n`);
      process.stdout.write('Tip: export SLACK_APP_ID=<app_id> for future updates.\n');
    }
    printSummary(options);
    return;
  }

  const payload = await callSlackApi(token, 'apps.manifest.update', {
    app_id: options.appId,
    manifest
  });
  process.stdout.write(`Slack app ${options.appId} updated from manifest.\n`);
  const warning = (payload as Record<string, unknown>).warning;
  if (typeof warning === 'string' && warning.trim()) {
    process.stdout.write(`- warning: ${warning}\n`);
  }
  printSummary(options);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error.';
  process.stderr.write(`slack-manifest failed: ${message}\n`);
  process.exit(1);
});
