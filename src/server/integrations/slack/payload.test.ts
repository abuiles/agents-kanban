import { describe, expect, it } from 'vitest';
import { parseSlackSlashCommandBody } from './payload';

describe('parseSlackSlashCommandBody', () => {
  it('parses fix jira-key command', () => {
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix abc-123',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'T123',
      user_id: 'U123',
      response_url: 'https://hooks.slack.test/fix'
    }).toString();

    const payload = parseSlackSlashCommandBody(rawBody);
    expect(payload.intent).toBe('fix');
    if (payload.intent === 'fix') {
      expect(payload.issueKey).toBe('ABC-123');
    }
  });

  it('parses help command', () => {
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'help',
      channel_id: 'C123',
      team_id: 'T123',
      user_id: 'U123',
      response_url: 'https://hooks.slack.test/help'
    }).toString();

    const payload = parseSlackSlashCommandBody(rawBody);
    expect(payload.intent).toBe('help');
  });

  it('rejects unsupported format', () => {
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'status ABC-123',
      channel_id: 'C123'
    }).toString();

    expect(() => parseSlackSlashCommandBody(rawBody)).toThrow(
      'Invalid slash command format. Expected: /kanvy fix <JIRA_KEY> or /kanvy help.'
    );
  });
});
