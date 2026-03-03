export type ConnectionState = 'connected' | 'connecting' | 'disconnected';

type SandboxAddonOptions = {
  getWebSocketUrl?: (ctx: { origin: string }) => string;
  onStateChange?: (state: ConnectionState) => void;
};

export class SandboxAddon {
  #onStateChange?: (state: ConnectionState) => void;

  constructor(options: SandboxAddonOptions = {}) {
    this.#onStateChange = options.onStateChange;
  }

  connect() {
    this.#onStateChange?.('connected');
  }

  dispose() {
    this.#onStateChange?.('disconnected');
  }
}
