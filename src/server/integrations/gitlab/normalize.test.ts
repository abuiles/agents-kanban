import { describe, expect, it } from 'vitest';
import { normalizeGitlabReviewEvent } from './normalize';

describe('gitlab feedback normalization', () => {
  it('normalizes merge-request note feedback events', () => {
    const normalized = normalizeGitlabReviewEvent({
      object_kind: 'note',
      project: { path_with_namespace: 'group/project' },
      merge_request: { iid: 42, web_url: 'https://gitlab.example/group/project/-/merge_requests/42' },
      user: { username: 'alice' },
      object_attributes: {
        id: 9001,
        noteable_type: 'MergeRequest',
        note: 'Please add tests for this path.',
        system: false
      }
    });

    expect(normalized).toMatchObject({
      type: 'review_feedback',
      projectPath: 'group/project',
      reviewNumber: 42,
      authorUsername: 'alice',
      note: 'Please add tests for this path.'
    });
  });

  it('normalizes merge request open/reopen/update events to review pending', () => {
    const normalized = normalizeGitlabReviewEvent({
      object_kind: 'merge_request',
      project: { path_with_namespace: 'group/project' },
      object_attributes: {
        iid: 7,
        action: 'open',
        state: 'opened',
        url: 'https://gitlab.example/group/project/-/merge_requests/7'
      }
    });

    expect(normalized).toMatchObject({
      type: 'review_pending',
      projectPath: 'group/project',
      reviewNumber: 7
    });
  });

  it('ignores non-review webhook payloads', () => {
    const normalized = normalizeGitlabReviewEvent({ object_kind: 'pipeline' });
    expect(normalized).toBeUndefined();
  });
});
