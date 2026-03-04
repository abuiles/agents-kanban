import { extractFindingMarkersFromText } from '../../review-posting/adapter';

export type GitHubReplyContextHint = {
  findingId: string;
  runId?: string;
  body: string;
};

export type NormalizedGitHubReplyEvent = {
  providerEventId: string;
  projectPath: string;
  reviewNumber: number;
  hints: GitHubReplyContextHint[];
};

type GitHubRepository = {
  full_name?: string;
};

type GitHubPullRequest = {
  number?: number;
};

type GitHubIssue = {
  number?: number;
  pull_request?: Record<string, unknown>;
};

type GitHubComment = {
  id?: number;
  body?: string;
};

type GitHubReview = {
  id?: number;
  body?: string;
};

type GitHubWebhookPayload = {
  action?: string;
  repository?: GitHubRepository;
  pull_request?: GitHubPullRequest;
  issue?: GitHubIssue;
  comment?: GitHubComment;
  review?: GitHubReview;
};

const REVIEW_COMMENT_ACTIONS = new Set(['created', 'edited']);
const REVIEW_ACTIONS = new Set(['submitted', 'edited']);
const ISSUE_COMMENT_ACTIONS = new Set(['created', 'edited']);

function normalizeProjectPath(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().replace(/^\/+|\/+$/g, '');
  return value || undefined;
}

function normalizeBody(body: string | undefined) {
  const value = body?.trim();
  if (!value) {
    return undefined;
  }
  return value.slice(0, 4000);
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function normalizeHints(body: string) {
  const unique = new Map<string, GitHubReplyContextHint>();
  for (const marker of extractFindingMarkersFromText(body)) {
    const key = `${marker.findingId}:${marker.runId}`;
    if (!unique.has(key)) {
      unique.set(key, {
        findingId: marker.findingId,
        runId: marker.runId,
        body
      });
    }
  }
  return [...unique.values()];
}

function normalizeReviewCommentEvent(payload: GitHubWebhookPayload): NormalizedGitHubReplyEvent | undefined {
  const action = payload.action?.toLowerCase();
  if (!action || !REVIEW_COMMENT_ACTIONS.has(action)) {
    return undefined;
  }

  const projectPath = normalizeProjectPath(payload.repository?.full_name);
  const reviewNumber = payload.pull_request?.number;
  const body = normalizeBody(payload.comment?.body);
  if (!projectPath || !reviewNumber || !body) {
    return undefined;
  }

  const hints = normalizeHints(body);
  if (hints.length === 0) {
    return undefined;
  }

  const providerEventId = payload.comment?.id
    ? `pull_request_review_comment:${payload.comment.id}`
    : `pull_request_review_comment:${reviewNumber}:${hashText(body)}`;

  return {
    providerEventId,
    projectPath,
    reviewNumber,
    hints
  };
}

function normalizePullRequestReviewEvent(payload: GitHubWebhookPayload): NormalizedGitHubReplyEvent | undefined {
  const action = payload.action?.toLowerCase();
  if (!action || !REVIEW_ACTIONS.has(action)) {
    return undefined;
  }

  const projectPath = normalizeProjectPath(payload.repository?.full_name);
  const reviewNumber = payload.pull_request?.number;
  const body = normalizeBody(payload.review?.body);
  if (!projectPath || !reviewNumber || !body) {
    return undefined;
  }

  const hints = normalizeHints(body);
  if (hints.length === 0) {
    return undefined;
  }

  const providerEventId = payload.review?.id
    ? `pull_request_review:${payload.review.id}`
    : `pull_request_review:${reviewNumber}:${hashText(body)}`;

  return {
    providerEventId,
    projectPath,
    reviewNumber,
    hints
  };
}

function normalizeIssueCommentEvent(payload: GitHubWebhookPayload): NormalizedGitHubReplyEvent | undefined {
  const action = payload.action?.toLowerCase();
  if (!action || !ISSUE_COMMENT_ACTIONS.has(action)) {
    return undefined;
  }

  if (!payload.issue?.pull_request) {
    return undefined;
  }

  const projectPath = normalizeProjectPath(payload.repository?.full_name);
  const reviewNumber = payload.issue?.number;
  const body = normalizeBody(payload.comment?.body);
  if (!projectPath || !reviewNumber || !body) {
    return undefined;
  }

  const hints = normalizeHints(body);
  if (hints.length === 0) {
    return undefined;
  }

  const providerEventId = payload.comment?.id
    ? `issue_comment:${payload.comment.id}`
    : `issue_comment:${reviewNumber}:${hashText(body)}`;

  return {
    providerEventId,
    projectPath,
    reviewNumber,
    hints
  };
}

export function normalizeGithubReplyContextEvent(eventType: string | null, payload: unknown): NormalizedGitHubReplyEvent | undefined {
  if (!eventType || !payload || typeof payload !== 'object') {
    return undefined;
  }

  const normalizedEventType = eventType.trim().toLowerCase();
  const parsedPayload = payload as GitHubWebhookPayload;

  if (normalizedEventType === 'pull_request_review_comment') {
    return normalizeReviewCommentEvent(parsedPayload);
  }
  if (normalizedEventType === 'pull_request_review') {
    return normalizePullRequestReviewEvent(parsedPayload);
  }
  if (normalizedEventType === 'issue_comment') {
    return normalizeIssueCommentEvent(parsedPayload);
  }
  return undefined;
}
