import type { IntegrationIssueRef, IssueSourceIntegration } from '../interfaces';
import { badRequest } from '../../http/errors';
import { redactSensitiveText } from '../../security/redaction';

type HttpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

type JiraIssueSourceOptions = {
  baseUrl: string;
  authEmail?: string;
  authToken?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

type NormalizedJiraIssueSourceOptions = {
  baseUrl: string;
  authEmail?: string;
  authToken?: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  fetcher: HttpFetcher;
};

type JiraIssuePayload = {
  key?: unknown;
  self?: unknown;
  fields?: {
    description?: unknown;
    summary?: unknown;
    project?: { key?: unknown };
  };
};

type TimeoutError = Error & { retryable?: boolean };

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/i;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const defaultFetcher: HttpFetcher = (input, init) => globalThis.fetch(input, init);

function readHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return 'unknown';
  }
}

function readIssueKeyFromUrl(url: string) {
  const match = /\/issue\/([A-Z][A-Z0-9_]*-\d+)/i.exec(url);
  return match?.[1]?.toUpperCase() ?? 'unknown';
}

function readPath(value: string) {
  try {
    return new URL(value).pathname || '/';
  } catch {
    return 'unknown';
  }
}

function logJiraFetchLifecycle(
  level: 'warn' | 'error',
  event: string,
  details: Record<string, unknown>
) {
  const writer = level === 'warn' ? console.warn : console.error;
  writer(`[jira:fetch] ${event} ${redactSensitiveText(JSON.stringify(details))}`);
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function encodeBasicAuthToken(username: string, token: string) {
  const credentials = `${username}:${token}`;
  if (typeof btoa === 'function') {
    return btoa(credentials);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(credentials, 'utf-8').toString('base64');
  }
  return '';
}

function buildIssueEndpoint(baseUrl: string, issueKey: string) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const lowerBase = normalizedBase.toLowerCase();
  const separator = lowerBase.includes('/rest/api/3') ? '/issue/' : '/rest/api/3/issue/';
  return `${normalizedBase}${separator}${issueKey}`;
}

function normalizeJiraText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeJiraText(item))
      .filter((entry) => entry)
      .join('\n');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text.trim();
  }
  if (typeof record.value === 'string') {
    return record.value.trim();
  }
  if (Array.isArray(record.content)) {
    return normalizeJiraText(record.content);
  }
  return '';
}

function toTimeoutError(message: string): TimeoutError {
  const error = new Error(message) as TimeoutError;
  error.retryable = true;
  return error;
}

function isRetryableStatus(status: number) {
  return status >= 500 || status === 429 || status === 408;
}

function buildIssueBrowseUrl(baseUrl: string, fallbackIssueKey: string, self?: string) {
  if (self && self.includes('/browse/')) {
    return self;
  }

  const normalizedSelf = readString(self);
  if (normalizedSelf) {
    const replacement = normalizedSelf.replace('/rest/api/3/issue/', '/browse/').replace('/rest/api/2/issue/', '/browse/');
    if (replacement !== normalizedSelf && replacement.includes('/browse/')) {
      return replacement;
    }
  }

  const normalizedBase = readString(baseUrl)?.replace(/\/$/, '') ?? '';
  if (!normalizedBase) {
    return undefined;
  }

  const browserBase = normalizedBase.includes('/rest/api/')
    ? normalizedBase.replace(/\/rest\/api\/.*/, '')
    : normalizedBase;

  return `${browserBase}/browse/${fallbackIssueKey}`;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const nestedError = record.error;
  const nestedErrorMessage = nestedError && typeof nestedError === 'object'
    ? readString((nestedError as Record<string, unknown>).message)
    : undefined;
  const errorMessages = Array.isArray(record.errorMessages)
    ? record.errorMessages
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .join('; ')
    : undefined;
  return readString(record.message)
    ?? (errorMessages && errorMessages.length > 0 ? errorMessages : undefined)
    ?? nestedErrorMessage;
}

function toIntegrationIssue(payload: unknown, fallbackIssueKey: string, baseUrl: string): IntegrationIssueRef {
  const issue = payload as JiraIssuePayload;
  const fields = issue.fields ?? {};
  const title = readString(fields.summary) || fallbackIssueKey;
  const body = normalizeJiraText(fields.description) || 'No description provided.';
  const resolvedIssueKey = readString(issue.key) || fallbackIssueKey;
  return {
    issueKey: resolvedIssueKey,
    title,
    body,
    url: buildIssueBrowseUrl(baseUrl, resolvedIssueKey, readString(issue.self))
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class RetryableRequestError extends Error {
  readonly retryable = true;
}

export class JiraMcpIssueSourceIntegration implements IssueSourceIntegration {
  readonly pluginKind: 'jira' = 'jira';
  private readonly options: NormalizedJiraIssueSourceOptions;

  constructor(input: JiraIssueSourceOptions, fetcher: HttpFetcher = defaultFetcher) {
    const baseUrl = readString(input.baseUrl);
    if (!baseUrl) {
      throw badRequest('Jira integration requires a base URL.');
    }

    this.options = {
      baseUrl,
      authEmail: readString(input.authEmail),
      authToken: readString(input.authToken),
      timeoutMs: readPositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS),
      maxAttempts: readPositiveInt(input.maxAttempts, DEFAULT_MAX_ATTEMPTS),
      retryDelayMs: readPositiveInt(input.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
      fetcher
    };
  }

  async fetchIssue(issueRef: string, _tenantId: string): Promise<IntegrationIssueRef> {
    const issueKey = readString(issueRef)?.toUpperCase();
    if (!issueKey || !ISSUE_KEY_PATTERN.test(issueKey)) {
      throw badRequest('Invalid Jira issue key.');
    }
    const issueEndpoint = buildIssueEndpoint(this.options.baseUrl, issueKey);
    console.info(JSON.stringify({
      event: 'jira_fetch_start',
      issueKey,
      jiraHost: readHost(this.options.baseUrl),
      jiraBasePath: readPath(this.options.baseUrl),
      jiraIssuePath: readPath(issueEndpoint),
      hasAuthEmail: Boolean(this.options.authEmail?.trim()),
      hasAuthToken: Boolean(this.options.authToken?.trim()),
      timeoutMs: this.options.timeoutMs,
      maxAttempts: this.options.maxAttempts
    }));

    let response: Response;
    try {
      response = await this.fetchWithRetry(issueEndpoint);
    } catch (error) {
      logJiraFetchLifecycle('error', 'request_failed', {
        issueKey,
        jiraHost: readHost(this.options.baseUrl),
        maxAttempts: this.options.maxAttempts,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = extractErrorMessage(payload);
      const normalizedMessage = message ? `: ${message}` : '';
      const normalizedMessageWithPeriod = message
        ? `: ${message.endsWith('.') ? message : `${message}.`}`
        : '.';

      if (response.status === 404) {
        throw badRequest(`Jira issue ${issueKey} not found${normalizedMessageWithPeriod}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw badRequest(`Jira authentication failed while loading ${issueKey}.`);
      }
      if (isRetryableStatus(response.status)) {
        throw toTimeoutError(`Failed to load Jira issue ${issueKey} (${response.status}).`);
      }
      throw badRequest(`Failed to load Jira issue ${issueKey} (${response.status}).`);
    }

    return toIntegrationIssue(payload, issueKey, this.options.baseUrl);
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let attempt = 0;
    let lastRetryableError: Error | undefined;
    const jiraHost = readHost(this.options.baseUrl);
    const issueKey = readIssueKeyFromUrl(url);

    while (attempt < this.options.maxAttempts) {
      attempt += 1;
      try {
        const response = await this.fetchOnce(url);
        if (response.ok) {
          return response;
        }

        if (!isRetryableStatus(response.status)) {
          return response;
        }

        if (attempt < this.options.maxAttempts) {
          logJiraFetchLifecycle('warn', 'retryable_status', {
            issueKey,
            jiraHost,
            status: response.status,
            attempt,
            maxAttempts: this.options.maxAttempts
          });
          await sleep(this.options.retryDelayMs);
          continue;
        }

        return response;
      } catch (error) {
        const typedError = (error instanceof Error ? error : new Error('Unknown Jira request error.')) as TimeoutError;
        if ((typedError instanceof RetryableRequestError) || (typedError instanceof DOMException) || typedError.retryable) {
          lastRetryableError = typedError;
          if (attempt < this.options.maxAttempts) {
            logJiraFetchLifecycle('warn', 'retryable_error', {
              issueKey,
              jiraHost,
              attempt,
              maxAttempts: this.options.maxAttempts,
              error: typedError.message
            });
            await sleep(this.options.retryDelayMs);
            continue;
          }
        }

        throw typedError;
      }
    }

    throw lastRetryableError ?? new Error('Failed to fetch Jira issue.');
  }

  private async fetchOnce(url: string): Promise<Response> {
    const headers: HeadersInit = {
      Accept: 'application/json'
    };
    if (this.options.authToken && this.options.authEmail) {
      headers.Authorization = `Basic ${encodeBasicAuthToken(this.options.authEmail, this.options.authToken)}`;
    } else if (this.options.authToken) {
      headers.Authorization = `Bearer ${this.options.authToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs);

    try {
      const response = await this.options.fetcher(url, { headers, signal: controller.signal }).catch((error) => {
        throw error instanceof Error ? error : new Error('Unknown fetch error.');
      });

      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw toTimeoutError('Jira read request timed out.');
      }
      if (error instanceof RetryableRequestError) {
        throw error;
      }
      if (error instanceof Error && error.message.includes('timed out')) {
        throw error;
      }
      logJiraFetchLifecycle('warn', 'network_unreachable', {
        issueKey: readIssueKeyFromUrl(url),
        jiraHost: readHost(this.options.baseUrl),
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error('Unable to reach Jira issue endpoint.');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createJiraIssueSourceIntegrationFromEnv(env: Env, tenantId: string) {
  const envValues = env as unknown as Record<string, string | undefined>;
  const baseUrl = envValues.JIRA_API_BASE_URL ?? envValues.JIRA_API_URL ?? ``;
  const authEmail = envValues.JIRA_EMAIL ?? envValues.JIRA_USER_EMAIL;
  const authToken = envValues.JIRA_API_TOKEN;
  const timeoutMs = readPositiveInt(envValues.JIRA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxAttempts = readPositiveInt(envValues.JIRA_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = readPositiveInt(envValues.JIRA_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS);
  console.info(JSON.stringify({
    event: 'jira_fetch_config',
    tenantId,
    jiraHost: readHost(baseUrl),
    jiraBasePath: readPath(baseUrl),
    hasAuthEmail: Boolean(authEmail?.trim()),
    hasAuthToken: Boolean(authToken?.trim()),
    timeoutMs,
    maxAttempts,
    retryDelayMs
  }));
  return new JiraMcpIssueSourceIntegration({
    baseUrl,
    authEmail,
    authToken,
    timeoutMs,
    maxAttempts,
    retryDelayMs
  });
}
