import { describe, expect, it } from 'vitest';
import { buildReviewFindingMarker } from '../../review-posting/adapter';
import { normalizeGithubReplyContextEvent } from './normalize';

describe('normalizeGithubReplyContextEvent', () => {
  it('normalizes pull_request_review_comment events with markers', () => {
    const marker = buildReviewFindingMarker('rf_1', 'run_1');
    const normalized = normalizeGithubReplyContextEvent('pull_request_review_comment', {
      action: 'created',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 42 },
      comment: { id: 10, body: `${marker} Please adjust the API validation.` }
    });

    expect(normalized).toMatchObject({
      providerEventId: 'pull_request_review_comment:10',
      projectPath: 'acme/demo',
      reviewNumber: 42,
      hints: [{ findingId: 'rf_1', runId: 'run_1' }]
    });
  });

  it('normalizes pull_request_review events with markers', () => {
    const marker = buildReviewFindingMarker('rf_2', 'run_9');
    const normalized = normalizeGithubReplyContextEvent('pull_request_review', {
      action: 'submitted',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 12 },
      review: { id: 88, body: `${marker} This should be split into two checks.` }
    });

    expect(normalized).toMatchObject({
      providerEventId: 'pull_request_review:88',
      projectPath: 'acme/demo',
      reviewNumber: 12,
      hints: [{ findingId: 'rf_2', runId: 'run_9' }]
    });
  });

  it('normalizes issue_comment events on pull requests with markers', () => {
    const marker = buildReviewFindingMarker('rf_3', 'run_3');
    const normalized = normalizeGithubReplyContextEvent('issue_comment', {
      action: 'created',
      repository: { full_name: 'acme/demo' },
      issue: { number: 12, pull_request: { url: 'https://api.github.com/repos/acme/demo/pulls/12' } },
      comment: { id: 51, body: `${marker} Follow-up for summary thread.` }
    });

    expect(normalized).toMatchObject({
      providerEventId: 'issue_comment:51',
      projectPath: 'acme/demo',
      reviewNumber: 12,
      hints: [{ findingId: 'rf_3', runId: 'run_3' }]
    });
  });

  it('ignores events without supported markers', () => {
    const normalized = normalizeGithubReplyContextEvent('pull_request_review_comment', {
      action: 'created',
      repository: { full_name: 'acme/demo' },
      pull_request: { number: 42 },
      comment: { id: 10, body: 'No marker present here.' }
    });

    expect(normalized).toBeUndefined();
  });
});
