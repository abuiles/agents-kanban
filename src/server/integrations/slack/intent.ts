const DEFAULT_MODEL = 'gpt-5.1-codex-mini';
const DEFAULT_REASONING_EFFORT = 'low';
const DEFAULT_AUTO_CREATE = true;
const DEFAULT_CLARIFY_MAX_TURNS = 4;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const INTENT_CONFIDENCE_THRESHOLD = 0.8;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/i;

export type SlackIntentType = 'fix_jira' | 'create_task' | 'unknown';

export type SlackIntentSettings = {
  intentEnabled: boolean;
  intentModel: string;
  intentReasoningEffort: 'low' | 'medium' | 'high';
  intentAutoCreate: boolean;
  intentClarifyMaxTurns: number;
  defaultRepoId?: string;
};

export type SlackIntentParseResult = {
  intent: SlackIntentType;
  confidence: number;
  jiraKey?: string;
  repoId?: string;
  repoHint?: string;
  taskTitle?: string;
  taskPrompt?: string;
  acceptanceCriteria: string[];
  missingFields: string[];
  clarifyingQuestion?: string;
};

export type SlackIntakeSessionStatus = 'active' | 'completed' | 'cancelled' | 'handoff';

export type SlackIntakeSession = {
  key: string;
  tenantId: string;
  channelId: string;
  threadTs: string;
  status: SlackIntakeSessionStatus;
  turnCount: number;
  maxTurns: number;
  updatedAt: string;
  createdAt: string;
  lastUserMessage: string;
  parse: SlackIntentParseResult;
};

function clampConfidence(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeIntent(value: unknown): SlackIntentType {
  if (value === 'fix_jira' || value === 'create_task') {
    return value;
  }
  return 'unknown';
}

function normalizeString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCriteria(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => Boolean(entry));
}

function normalizeMissingFields(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => Boolean(entry));
}

function deriveTaskTitleFromText(text: string) {
  const sanitized = text.replace(/\s+/g, ' ').trim();
  if (!sanitized) {
    return 'Slack intake task';
  }
  const sentence = sanitized.split(/[.!?]/, 1)[0] ?? sanitized;
  return sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence;
}

function parseFallbackIntent(text: string): SlackIntentParseResult {
  const trimmed = text.trim();
  const jiraMatch = /^fix\s+([A-Z][A-Z0-9_]*-\d+)\s*$/i.exec(trimmed);
  if (jiraMatch?.[1]) {
    return {
      intent: 'fix_jira',
      confidence: 1,
      jiraKey: jiraMatch[1].toUpperCase(),
      acceptanceCriteria: [],
      missingFields: []
    };
  }

  const hasRepoHint = /(?:repo|repository|in)\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)/i.exec(trimmed)?.[1];
  const prompt = trimmed;
  const title = deriveTaskTitleFromText(trimmed);
  const confidence = prompt.length >= 15 ? 0.85 : 0.55;
  const missingFields = [];
  if (!prompt) {
    missingFields.push('taskPrompt');
  }

  return {
    intent: prompt ? 'create_task' : 'unknown',
    confidence,
    repoHint: hasRepoHint,
    taskTitle: prompt ? title : undefined,
    taskPrompt: prompt || undefined,
    acceptanceCriteria: [],
    missingFields,
    clarifyingQuestion: prompt
      ? 'Which repository should this run against?'
      : 'What task should I create? Please describe the goal and expected result.'
  };
}

function parseModelOutput(raw: unknown): SlackIntentParseResult | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const jiraKey = normalizeString(obj.jiraKey);
  const normalizedJiraKey = jiraKey && ISSUE_KEY_PATTERN.test(jiraKey) ? jiraKey.toUpperCase() : undefined;
  return {
    intent: normalizeIntent(obj.intent),
    confidence: clampConfidence(obj.confidence),
    jiraKey: normalizedJiraKey,
    repoId: normalizeString(obj.repoId),
    repoHint: normalizeString(obj.repoHint),
    taskTitle: normalizeString(obj.taskTitle),
    taskPrompt: normalizeString(obj.taskPrompt),
    acceptanceCriteria: normalizeCriteria(obj.acceptanceCriteria),
    missingFields: normalizeMissingFields(obj.missingFields),
    clarifyingQuestion: normalizeString(obj.clarifyingQuestion)
  };
}

function extractResponseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const fragment of content) {
      if (!fragment || typeof fragment !== 'object') {
        continue;
      }
      const text = (fragment as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
  }
  return undefined;
}

async function parseWithModel(
  env: Env,
  text: string,
  settings: SlackIntentSettings
): Promise<SlackIntentParseResult | undefined> {
  const apiKey = await env.SECRETS_KV.get('openai/api-key');
  if (!apiKey?.trim()) {
    return undefined;
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: ['fix_jira', 'create_task', 'unknown'] },
      confidence: { type: 'number' },
      jiraKey: { type: 'string' },
      repoId: { type: 'string' },
      repoHint: { type: 'string' },
      taskTitle: { type: 'string' },
      taskPrompt: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' } },
      missingFields: { type: 'array', items: { type: 'string' } },
      clarifyingQuestion: { type: 'string' }
    },
    required: ['intent', 'confidence', 'acceptanceCriteria', 'missingFields']
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.intentModel || DEFAULT_MODEL,
      reasoning: { effort: settings.intentReasoningEffort || DEFAULT_REASONING_EFFORT },
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'Parse Slack command intent. Return only valid JSON.'
            }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text }]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'slack_intake_intent',
          schema,
          strict: true
        }
      }
    })
  });
  if (!response.ok) {
    return undefined;
  }
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!payload) {
    return undefined;
  }
  const responseText = extractResponseText(payload);
  if (!responseText) {
    return undefined;
  }
  const parsed = JSON.parse(responseText) as unknown;
  return parseModelOutput(parsed);
}

export async function parseSlackIntentText(
  env: Env,
  text: string,
  settings: SlackIntentSettings
): Promise<SlackIntentParseResult> {
  try {
    const modelResult = await parseWithModel(env, text, settings);
    if (modelResult) {
      return modelResult;
    }
  } catch {
    // Fallback stays deterministic.
  }
  return parseFallbackIntent(text);
}

export function buildSlackIntakeSessionKey(tenantId: string, channelId: string, threadTs: string) {
  return `slack:intake:${tenantId}:${channelId}:${threadTs}`;
}

export async function getSlackIntakeSession(env: Env, key: string): Promise<SlackIntakeSession | undefined> {
  const stored = await env.SECRETS_KV.get(key);
  if (!stored) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stored) as SlackIntakeSession;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function putSlackIntakeSession(env: Env, session: SlackIntakeSession): Promise<void> {
  await env.SECRETS_KV.put(session.key, JSON.stringify(session), {
    expirationTtl: DEFAULT_SESSION_TTL_SECONDS
  });
}

export function mergeIntentState(
  previous: SlackIntentParseResult,
  next: SlackIntentParseResult
): SlackIntentParseResult {
  return {
    intent: next.intent !== 'unknown' ? next.intent : previous.intent,
    confidence: Math.max(previous.confidence, next.confidence),
    jiraKey: next.jiraKey ?? previous.jiraKey,
    repoId: next.repoId ?? previous.repoId,
    repoHint: next.repoHint ?? previous.repoHint,
    taskTitle: next.taskTitle ?? previous.taskTitle,
    taskPrompt: next.taskPrompt ?? previous.taskPrompt,
    acceptanceCriteria: next.acceptanceCriteria.length > 0 ? next.acceptanceCriteria : previous.acceptanceCriteria,
    missingFields: next.missingFields.length > 0 ? next.missingFields : previous.missingFields,
    clarifyingQuestion: next.clarifyingQuestion ?? previous.clarifyingQuestion
  };
}

export function isIntentComplete(parse: SlackIntentParseResult) {
  if (parse.intent !== 'create_task') {
    return false;
  }
  if (parse.confidence < INTENT_CONFIDENCE_THRESHOLD) {
    return false;
  }
  if (!parse.taskTitle || !parse.taskPrompt) {
    return false;
  }
  return true;
}

export function buildClarificationQuestion(parse: SlackIntentParseResult) {
  return parse.clarifyingQuestion
    ?? 'Please clarify repository, objective, and acceptance criteria.';
}

export function defaultSlackIntentSettings(): SlackIntentSettings {
  return {
    intentEnabled: true,
    intentModel: DEFAULT_MODEL,
    intentReasoningEffort: DEFAULT_REASONING_EFFORT,
    intentAutoCreate: DEFAULT_AUTO_CREATE,
    intentClarifyMaxTurns: DEFAULT_CLARIFY_MAX_TURNS
  };
}

