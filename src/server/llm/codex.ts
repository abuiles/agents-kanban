import type { LlmAdapter } from './adapter';

export const codexLlmAdapter: LlmAdapter = {
  kind: 'codex',
  capabilities: {
    supportsResume: true,
    supportsTakeover: true,
    resumeCommandLabel: 'Codex resume command'
  },

  async ensureInstalled() {
    throw new Error('Codex adapter ensureInstalled is not wired yet.');
  },

  async restoreAuth() {
    throw new Error('Codex adapter restoreAuth is not wired yet.');
  },

  async logDiagnostics() {
    throw new Error('Codex adapter logDiagnostics is not wired yet.');
  },

  async waitForCapacityIfNeeded() {
    throw new Error('Codex adapter waitForCapacityIfNeeded is not wired yet.');
  },

  async run() {
    throw new Error('Codex adapter run is not wired yet.');
  },

  extractSessionState(chunk: string, fallbackSessionId?: string) {
    const sessionMatch = chunk.match(/"thread_id":"([^"]+)"/);
    const sessionId = sessionMatch?.[1] ?? fallbackSessionId;
    const resumeMatch = chunk.match(/codex resume ([a-z0-9-]+)/i);
    const resumeCommand = resumeMatch?.[1] ? `codex resume ${resumeMatch[1]}` : undefined;

    return {
      sessionId,
      resumeCommand
    };
  }
};
