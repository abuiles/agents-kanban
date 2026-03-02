import { describe, expect, it } from 'vitest';
import { getLlmAdapter, getLlmAdapterCapabilities, resolveLlmAdapterKind } from './registry';

describe('LLM adapter registry', () => {
  it('resolves adapter implementations generically by kind', () => {
    expect(getLlmAdapter('codex').kind).toBe('codex');
    expect(getLlmAdapter('cursor_cli').kind).toBe('cursor_cli');
  });

  it('resolves codex by default when no adapter is configured', () => {
    const kind = resolveLlmAdapterKind({ uiMeta: undefined });
    expect(kind).toBe('codex');
  });

  it('exposes executor capabilities including resume/takeover support', () => {
    expect(getLlmAdapterCapabilities('codex')).toMatchObject({
      supportsResume: true,
      supportsTakeover: true,
      resumeCommandLabel: 'Codex resume command'
    });

    expect(getLlmAdapterCapabilities('cursor_cli')).toMatchObject({
      supportsResume: false,
      supportsTakeover: false
    });
  });

  it('parses codex resume/session data through the adapter', () => {
    const parsed = getLlmAdapter('codex').extractSessionState?.(
      '{"thread_id":"thread-123"}\nUse this to continue later: codex resume thread-123'
    );

    expect(parsed).toEqual({
      sessionId: 'thread-123',
      resumeCommand: 'codex resume thread-123'
    });
  });
});
