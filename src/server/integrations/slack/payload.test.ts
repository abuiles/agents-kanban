import { describe, expect, it } from 'vitest';
import { parseJiraFastPathIssueKey, parseReviewFastPathInput, parseSlackSlashCommandBody } from './payload';

describe('slack payload parsing', () => {
  it('accepts free-text slash command input', () => {
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'draft MR for docs improvements',
      channel_id: 'C123',
      team_id: 'T1',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const parsed = parseSlackSlashCommandBody(rawBody);
    expect(parsed.text).toBe('draft MR for docs improvements');
    expect(parsed.channelId).toBe('C123');
  });

  it('keeps deterministic Jira fast-path parsing for fix <JIRA_KEY>', () => {
    expect(parseJiraFastPathIssueKey('fix ABC-123')).toBe('ABC-123');
    expect(parseJiraFastPathIssueKey('fix abc-123')).toBe('ABC-123');
    expect(parseJiraFastPathIssueKey('fix jira issue ABC-123')).toBeUndefined();
    expect(parseJiraFastPathIssueKey('draft mr')).toBeUndefined();
  });

  it('accepts help text as regular slash payload text', () => {
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'help',
      channel_id: 'C123',
      team_id: 'T1',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const parsed = parseSlackSlashCommandBody(rawBody);
    expect(parsed.text).toBe('help');
  });

  it('parses review fast-path number input', () => {
    expect(parseReviewFastPathInput('review 1234')).toEqual({ reviewNumber: 1234 });
  });

  it('parses review fast-path GitHub URL input', () => {
    expect(parseReviewFastPathInput('review https://github.com/abuiles/agents-kanban/pull/101')).toEqual({
      reviewNumber: 101,
      reviewUrl: 'https://github.com/abuiles/agents-kanban/pull/101',
      providerHint: 'github',
      repoHostHint: 'github.com',
      projectPathHint: 'abuiles/agents-kanban'
    });
  });

  it('parses review fast-path GitLab URL input', () => {
    expect(parseReviewFastPathInput('review https://gitlab.example.com/group/subgroup/minions/-/merge_requests/88')).toEqual({
      reviewNumber: 88,
      reviewUrl: 'https://gitlab.example.com/group/subgroup/minions/-/merge_requests/88',
      providerHint: 'gitlab',
      repoHostHint: 'gitlab.example.com',
      projectPathHint: 'group/subgroup/minions'
    });
  });

  it('rejects unsupported review fast-path shapes', () => {
    expect(parseReviewFastPathInput('review')).toBeUndefined();
    expect(parseReviewFastPathInput('review abc')).toBeUndefined();
    expect(parseReviewFastPathInput('review https://github.com/abuiles/agents-kanban/issues/1')).toBeUndefined();
  });
});
