import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from './redaction';

describe('redactSensitiveText', () => {
  it('redacts bearer tokens and token headers', () => {
    const redacted = redactSensitiveText(
      'Authorization: Bearer abc.def.ghi\nx-api-token: secret-token\nx-session-token: session-secret'
    );

    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('x-api-token: [REDACTED]');
    expect(redacted).toContain('x-session-token: [REDACTED]');
    expect(redacted).not.toContain('secret-token');
    expect(redacted).not.toContain('session-secret');
  });

  it('redacts URL credentials, JSON secret fields, and shell secret exports', () => {
    const redacted = redactSensitiveText(
      'https://oauth2:glpat-secret@gitlab.example.com/group/repo.git {"access_token":"a1","password":"p1"} OPENAI_API_KEY=sk-live ANTHROPIC_API_KEY=sk-ant'
    );

    expect(redacted).toContain('https://oauth2:[REDACTED]@gitlab.example.com/group/repo.git');
    expect(redacted).toContain('"access_token":"[REDACTED]"');
    expect(redacted).toContain('"password":"[REDACTED]"');
    expect(redacted).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(redacted).toContain('ANTHROPIC_API_KEY=[REDACTED]');
    expect(redacted).not.toContain('glpat-secret');
    expect(redacted).not.toContain('sk-live');
    expect(redacted).not.toContain('sk-ant');
  });
});
