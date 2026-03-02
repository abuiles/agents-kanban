import type { LlmAdapter } from './adapter';

export const cursorCliLlmAdapter: LlmAdapter = {
  kind: 'cursor_cli',
  capabilities: {
    supportsResume: false,
    supportsTakeover: false
  },

  async ensureInstalled() {
    throw new Error('Cursor CLI adapter is not implemented yet.');
  },

  async restoreAuth() {
    throw new Error('Cursor CLI adapter is not implemented yet.');
  },

  async logDiagnostics() {
    throw new Error('Cursor CLI adapter is not implemented yet.');
  },

  async run() {
    throw new Error('Cursor CLI adapter is not implemented yet.');
  }
};
