import type { AutoReviewProvider, AgentRun, Repo, ReviewFinding, Task } from '../../ui/domain/types';

export type ReviewPostingCredential = {
  token: string;
};

export type ReviewPostingInput = {
  repo: Repo;
  task: Task;
  run: AgentRun;
  findings: ReviewFinding[];
  credential: ReviewPostingCredential;
  postInline?: boolean;
};

export type ReviewPostingFindingRecord = {
  findingId: string;
  posted: boolean;
  inline: boolean;
  summary: boolean;
  providerThreadId?: string;
  providerThreadUrl?: string;
  reason?: string;
};

export type ReviewPostingResult = {
  provider: AutoReviewProvider;
  findings: ReviewPostingFindingRecord[];
  updatedFindings: ReviewFinding[];
  summary?: {
    posted: boolean;
    providerThreadId?: string;
    providerThreadUrl?: string;
    reason?: string;
  };
  errors: string[];
};

export type ReviewReplyFetchInput = Omit<ReviewPostingInput, 'findings'> & {
  findingIds?: string[];
};

export type ReviewReplyContext = Record<string, string[]>;

export interface ReviewPostingAdapter {
  readonly provider: AutoReviewProvider;
  postFindings(input: ReviewPostingInput): Promise<ReviewPostingResult>;
  fetchReplyContext(input: ReviewReplyFetchInput): Promise<ReviewReplyContext>;
}

export const REVIEW_MARKER_TAG = 'agentboard-review';
const FINDING_MARKER_RE = /<!--\s*agentboard-review:finding:([^:\s>]+):([^>\s]+)\s*-->/g;
const SUMMARY_MARKER_RE = /<!--\s*agentboard-review:summary:([^>\s]+)\s*-->/;

export const REVIEW_POSTING_MAX_ATTEMPTS = 3;

type RetryOptions = {
  maxAttempts?: number;
  operation: () => Promise<unknown>;
};

export async function retryReviewPosting<T>(
  input: RetryOptions,
  context: string
): Promise<T> {
  const maxAttempts = input.maxAttempts ?? REVIEW_POSTING_MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await input.operation() as T;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      console.error(
        `${context}: attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}). Retrying with attempt ${attempt + 1}/${maxAttempts}.`
      );
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`${context}: all ${maxAttempts} attempts failed. Last error: ${lastError.message}`);
  }
  throw new Error(`${context}: all ${maxAttempts} attempts failed. Last error: ${String(lastError)}`);
}

export function buildReviewFindingMarker(findingId: string, runId: string) {
  return `<!-- agentboard-review:finding:${findingId}:${runId} -->`;
}

export function buildReviewSummaryMarker(runId: string) {
  return `<!-- agentboard-review:summary:${runId} -->`;
}

export function extractFindingIdsFromText(text: string) {
  const ids = new Set<string>();
  const matcher = new RegExp(FINDING_MARKER_RE.source, 'gi');
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

export function extractRunIdFromSummaryMarker(text: string) {
  const match = SUMMARY_MARKER_RE.exec(text);
  return match?.[1];
}

export function buildReviewFindingBody(input: {
  finding: ReviewFinding;
  marker: string;
  includeLocation: boolean;
}) {
  const location = input.includeLocation && input.finding.filePath
    ? buildFindingLocationLine(input.finding.filePath, input.finding.lineStart, input.finding.lineEnd)
    : undefined;

  return [
    input.marker,
    `### ${input.finding.findingId}: ${input.finding.title}`,
    '',
    input.finding.description,
    location ? `Location: ${location}` : undefined
  ].filter(Boolean).join('\n');
}

function buildFindingLocationLine(filePath: string, lineStart?: number, lineEnd?: number) {
  if (!lineStart && !lineEnd) {
    return filePath;
  }
  if (lineStart && !lineEnd) {
    return `${filePath}:${lineStart}`;
  }
  if (!lineStart && lineEnd) {
    return `${filePath}:${lineEnd}`;
  }
  if (lineStart === lineEnd) {
    return `${filePath}:${lineStart}`;
  }
  return `${filePath}:${lineStart}-${lineEnd}`;
}
