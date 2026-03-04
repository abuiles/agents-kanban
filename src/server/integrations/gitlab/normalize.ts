import type { ReviewIntegration } from '../interfaces';

export type NormalizedGitlabReviewEvent = {
  type: 'review_pending' | 'review_feedback';
  providerEventId: string;
  projectPath: string;
  reviewNumber: number;
  reviewUrl?: string;
  authorUsername?: string;
  note?: string;
};

type GitlabProject = {
  path_with_namespace?: string;
  web_url?: string;
};

type GitlabMrAttributes = {
  iid?: number;
  url?: string;
  action?: string;
  state?: string;
};

type GitlabMr = {
  iid?: number;
  web_url?: string;
};

type GitlabNoteEvent = {
  object_kind?: string;
  event_type?: string;
  project?: GitlabProject;
  merge_request?: GitlabMr;
  object_attributes?: {
    id?: number;
    note?: string;
    noteable_type?: string;
    system?: boolean;
  };
  user?: {
    username?: string;
  };
};

type GitlabMergeRequestEvent = {
  object_kind?: string;
  event_type?: string;
  project?: GitlabProject;
  object_attributes?: GitlabMrAttributes;
  user?: {
    username?: string;
  };
};

function normalizeProjectPath(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().replace(/^\/+|\/+$/g, '');
  return value || undefined;
}

function normalizeNoteEvent(payload: GitlabNoteEvent): NormalizedGitlabReviewEvent | undefined {
  if ((payload.object_kind ?? '').toLowerCase() !== 'note' && (payload.event_type ?? '').toLowerCase() !== 'note') {
    return undefined;
  }

  const attrs = payload.object_attributes;
  if (!attrs || attrs.noteable_type !== 'MergeRequest') {
    return undefined;
  }
  if (attrs.system) {
    return undefined;
  }

  const note = attrs.note?.trim();
  const projectPath = normalizeProjectPath(payload.project?.path_with_namespace);
  const reviewNumber = payload.merge_request?.iid;
  if (!projectPath || !reviewNumber || !note) {
    return undefined;
  }

  return {
    type: 'review_feedback',
    providerEventId: attrs.id ? `note:${attrs.id}` : `note:${reviewNumber}:${note.slice(0, 40)}`,
    projectPath,
    reviewNumber,
    reviewUrl: payload.merge_request?.web_url,
    authorUsername: payload.user?.username,
    note
  };
}

function normalizeMergeRequestEvent(payload: GitlabMergeRequestEvent): NormalizedGitlabReviewEvent | undefined {
  if ((payload.object_kind ?? '').toLowerCase() !== 'merge_request' && (payload.event_type ?? '').toLowerCase() !== 'merge_request') {
    return undefined;
  }

  const attrs = payload.object_attributes;
  const action = attrs?.action?.toLowerCase();
  const state = attrs?.state?.toLowerCase();
  const isReviewPending = action === 'open' || action === 'reopen' || (action === 'update' && state === 'opened');
  if (!isReviewPending) {
    return undefined;
  }

  const projectPath = normalizeProjectPath(payload.project?.path_with_namespace);
  const reviewNumber = attrs?.iid;
  if (!projectPath || !reviewNumber) {
    return undefined;
  }

  return {
    type: 'review_pending',
    providerEventId: `merge_request:${reviewNumber}:${action ?? 'update'}`,
    projectPath,
    reviewNumber,
    reviewUrl: attrs?.url
  };
}

export function normalizeGitlabReviewEvent(payload: unknown): NormalizedGitlabReviewEvent | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const note = normalizeNoteEvent(payload as GitlabNoteEvent);
  if (note) {
    return note;
  }
  return normalizeMergeRequestEvent(payload as GitlabMergeRequestEvent);
}

export class GitLabReviewIntegration implements ReviewIntegration {
  readonly pluginKind = 'gitlab' as const;

  normalizeWebhookReview(payload: unknown) {
    const normalized = normalizeGitlabReviewEvent(payload);
    if (!normalized) {
      return undefined;
    }

    return {
      tenantId: 'tenant_local',
      providerEventId: normalized.providerEventId,
      projectPath: normalized.projectPath,
      runId: normalized.reviewNumber ? `mr:${normalized.reviewNumber}` : undefined,
      note: normalized.note
    };
  }
}

export const gitlabReviewIntegration = new GitLabReviewIntegration();
