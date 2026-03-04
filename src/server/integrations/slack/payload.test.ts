import { describe, expect, it } from 'vitest';
import { parseJiraFastPathIssueKey, parseSlackSlashCommandBody } from './payload';

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
});
