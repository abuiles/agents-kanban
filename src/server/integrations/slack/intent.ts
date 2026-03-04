import type { IntegrationConfig, IntegrationConfigSettings } from '../../../ui/domain/types';
import { resolveIntegrationConfig } from '../config-resolution';

export type SlackIntentKind = 'fix_jira' | 'create_task' | 'unknown';

export type SlackIntentParseResult = {
  intent: SlackIntentKind;
  confidence: number;
  jiraKey?: string;
  repoHint?: string;
  repoId?: string;
  taskTitle?: string;
  taskPrompt?: string;
  acceptanceCriteria: string[];
  missingFields: string[];
  clarifyingQuestion?: string;
};

export type SlackIntentSettings = {
  intentEnabled: boolean;
  intentModel: string;
  intentReasoningEffort: 'low' | 'medium' | 'high';
  intentAutoCreate: boolean;
  intentClarifyMaxTurns: number;
  defaultRepoId?: string;
};

export const DEFAULT_INTENT_MODEL = 'gpt-5.1-codex-mini';

const INTENT_JSON_SCHEMA = {
  name: 'slack_intent_parser',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: ['fix_jira', 'create_task', 'unknown'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      jiraKey: { type: 'string' },
      repoHint: { type: 'string' },
      repoId: { type: 'string' },
      taskTitle: { type: 'string' },
      taskPrompt: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' } },
      missingFields: { type: 'array', items: { type: 'string' } },
      clarifyingQuestion: { type: 'string' }
    },
    required: ['intent', 'confidence', 'acceptanceCriteria', 'missingFields']
  },
  strict: true
} as const;

function readBoolean(settings: IntegrationConfigSettings, key: string, fallback: boolean): boolean {
  const value = settings[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }
  return fallback;
}

function readString(settings: IntegrationConfigSettings, key: string): string | undefined {
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readReasoningEffort(settings: IntegrationConfigSettings, fallback: SlackIntentSettings['intentReasoningEffort']) {
  const value = readString(settings, 'intentReasoningEffort');
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return fallback;
}

function readPositiveInt(settings: IntegrationConfigSettings, key: string, fallback: number): number {
  const value = settings[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeResult(raw: unknown): SlackIntentParseResult {
  const parsed = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const intent = parsed.intent === 'fix_jira' || parsed.intent === 'create_task' || parsed.intent === 'unknown'
    ? parsed.intent
    : 'unknown';
  const confidenceRaw = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const readStringValue = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const acceptanceCriteria = Array.isArray(parsed.acceptanceCriteria)
    ? parsed.acceptanceCriteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
  const missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];

  return {
    intent,
    confidence,
    jiraKey: readStringValue(parsed.jiraKey),
    repoHint: readStringValue(parsed.repoHint),
    repoId: readStringValue(parsed.repoId),
    taskTitle: readStringValue(parsed.taskTitle),
    taskPrompt: readStringValue(parsed.taskPrompt),
    acceptanceCriteria,
    missingFields,
    clarifyingQuestion: readStringValue(parsed.clarifyingQuestion)
  };
}

function fallbackIntent(text: string): SlackIntentParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      intent: 'unknown',
      confidence: 0,
      acceptanceCriteria: [],
      missingFields: ['intent'],
      clarifyingQuestion: 'Tell me what you want to accomplish, plus target repo (if known).'
    };
  }
  return {
    intent: 'create_task',
    confidence: 0.55,
    taskPrompt: trimmed,
    acceptanceCriteria: [],
    missingFields: ['repo', 'acceptanceCriteria'],
    clarifyingQuestion: 'Which repo should I use, and what are the acceptance criteria?'
  };
}

export function resolveSlackIntentSettings(
  configs: readonly IntegrationConfig[],
  scope: { tenantId: string; repoId?: string; channelId?: string }
): SlackIntentSettings {
  const config = resolveIntegrationConfig(configs, {
    tenantId: scope.tenantId,
    pluginKind: 'slack',
    repoId: scope.repoId,
    channelId: scope.channelId
  });
  const settings = config?.settings ?? {};
  return {
    intentEnabled: readBoolean(settings, 'intentEnabled', true),
    intentModel: readString(settings, 'intentModel') ?? DEFAULT_INTENT_MODEL,
    intentReasoningEffort: readReasoningEffort(settings, 'low'),
    intentAutoCreate: readBoolean(settings, 'intentAutoCreate', true),
    intentClarifyMaxTurns: readPositiveInt(settings, 'intentClarifyMaxTurns', 4),
    defaultRepoId: readString(settings, 'defaultRepoId')
  };
}

export async function parseSlackIntentWithLlm(
  env: Env,
  input: {
    text: string;
    settings: SlackIntentSettings;
    priorTurns: number;
  }
): Promise<SlackIntentParseResult> {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return fallbackIntent(trimmed);
  }
  const apiKey = (env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY?.trim();
  if (!apiKey || !input.settings.intentEnabled) {
    return fallbackIntent(trimmed);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: input.settings.intentModel || DEFAULT_INTENT_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'Parse Slack /kanvy free-text into a strict intent JSON object.',
              'Prefer intent=create_task for generic requests.',
              'Use intent=fix_jira only when user asks to fix a Jira issue.',
              'Return one targeted clarifyingQuestion if needed.'
            ].join(' ')
          },
          {
            role: 'user',
            content: `turn=${input.priorTurns}\ntext=${trimmed}`
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: INTENT_JSON_SCHEMA
        },
        temperature: 0
      })
    });
    if (!response.ok) {
      return fallbackIntent(trimmed);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = payload.choices?.[0]?.message?.content;
    if (!rawContent) {
      return fallbackIntent(trimmed);
    }
    const parsed = JSON.parse(rawContent);
    return normalizeResult(parsed);
  } catch {
    return fallbackIntent(trimmed);
  }
}
