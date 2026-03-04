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

export const DEFAULT_INTENT_MODEL = 'gpt-5-nano';
const INTENT_FALLBACK_MODELS = ['gpt-4.1-mini', 'gpt-4o-mini'] as const;

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
    required: [
      'intent',
      'confidence',
      'jiraKey',
      'repoHint',
      'repoId',
      'taskTitle',
      'taskPrompt',
      'acceptanceCriteria',
      'missingFields',
      'clarifyingQuestion'
    ]
  },
  strict: true
} as const;

function previewText(value: string, max = 140) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

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
    availableRepos?: string[];
  }
): Promise<SlackIntentParseResult> {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return fallbackIntent(trimmed);
  }
  const apiKey = (env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY?.trim();
  if (!apiKey || !input.settings.intentEnabled) {
    console.info(JSON.stringify({
      event: 'slack_intent_parse',
      phase: 'fallback',
      reason: !apiKey ? 'missing_api_key' : 'intent_disabled',
      priorTurns: input.priorTurns
    }));
    return fallbackIntent(trimmed);
  }

  const availableRepos = Array.isArray(input.availableRepos)
    ? input.availableRepos.filter((repoId) => typeof repoId === 'string' && repoId.trim().length > 0)
    : [];
  const availableReposBlock = availableRepos.length > 0
    ? `available_repos:\n${availableRepos.slice(0, 100).map((repoId) => `- ${repoId}`).join('\n')}`
    : 'available_repos:\n- unknown';

  const uniqueModels = Array.from(new Set([
    input.settings.intentModel || DEFAULT_INTENT_MODEL,
    ...INTENT_FALLBACK_MODELS
  ]));

  for (let index = 0; index < uniqueModels.length; index += 1) {
    const model = uniqueModels[index]!;
    const attempt = index + 1;
    const isLastAttempt = attempt >= uniqueModels.length;
    try {
      console.info(JSON.stringify({
        event: 'slack_intent_parse',
        phase: 'request',
        model,
        priorTurns: input.priorTurns,
        attempt,
        textPreview: previewText(trimmed)
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
                'Parse Slack /kanvy free-text into a strict intent JSON object.',
                'Prefer intent=create_task for generic requests.',
                'Use intent=fix_jira only when user asks to fix a Jira issue.',
                'Use any provided prior context to fill missing fields.',
                'If task goal is clear, do not require explicit acceptance criteria.',
                'Return one targeted clarifyingQuestion only when truly needed.'
              ].join(' ')
            },
            {
              role: 'user',
              content: `turn=${input.priorTurns}\n${availableReposBlock}\ntext=${trimmed}`
            }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: INTENT_JSON_SCHEMA
          }
        })
      });
      if (!response.ok) {
        const rawError = await response.text().catch(() => '');
        let errorCode: string | undefined;
        let errorMessage: string | undefined;
        try {
          const parsedError = rawError ? JSON.parse(rawError) as { error?: { code?: string; message?: string } } : undefined;
          errorCode = parsedError?.error?.code;
          errorMessage = parsedError?.error?.message;
        } catch {
          errorMessage = rawError || undefined;
        }
        console.warn(JSON.stringify({
          event: 'slack_intent_parse',
          phase: 'response_error',
          status: response.status,
          model,
          attempt,
          priorTurns: input.priorTurns,
          errorCode: errorCode ?? null,
          errorMessage: errorMessage ? previewText(errorMessage, 220) : null
        }));
        if (!isLastAttempt && (response.status === 400 || response.status === 404)) {
          continue;
        }
        return fallbackIntent(trimmed);
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawContent = payload.choices?.[0]?.message?.content;
      if (!rawContent) {
        console.warn(JSON.stringify({
          event: 'slack_intent_parse',
          phase: 'response_empty',
          model,
          attempt,
          priorTurns: input.priorTurns
        }));
        if (!isLastAttempt) {
          continue;
        }
        return fallbackIntent(trimmed);
      }
      const parsed = JSON.parse(rawContent);
      const normalized = normalizeResult(parsed);
      console.info(JSON.stringify({
        event: 'slack_intent_parse',
        phase: 'response_ok',
        model,
        attempt,
        priorTurns: input.priorTurns,
        intent: normalized.intent,
        confidence: normalized.confidence,
        hasRepoHint: Boolean(normalized.repoHint),
        hasRepoId: Boolean(normalized.repoId),
        hasTaskTitle: Boolean(normalized.taskTitle),
        hasTaskPrompt: Boolean(normalized.taskPrompt),
        missingFields: normalized.missingFields
      }));
      return normalized;
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'slack_intent_parse',
        phase: 'exception',
        model,
        attempt,
        priorTurns: input.priorTurns,
        errorMessage: error instanceof Error ? previewText(error.message, 220) : 'unknown'
      }));
      if (!isLastAttempt) {
        continue;
      }
      return fallbackIntent(trimmed);
    }
  }
  return fallbackIntent(trimmed);
}
