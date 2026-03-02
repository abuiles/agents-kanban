import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SandboxAddon, type ConnectionState } from '@cloudflare/sandbox/xterm';
import type { TerminalBootstrap } from '../domain/types';

import '@xterm/xterm/css/xterm.css';

export function RunTerminal({ bootstrap }: { bootstrap: TerminalBootstrap }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    if (!bootstrap.attachable || !bootstrap.wsPath || !hostRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", ui-monospace, monospace',
      fontSize: 12,
      theme: {
        background: '#040812',
        foreground: '#d8e4ff'
      }
    });
    const fitAddon = new FitAddon();
    const sandboxAddon = new SandboxAddon({
      getWebSocketUrl: ({ origin }) => `${origin}${bootstrap.wsPath ?? ''}`,
      onStateChange: (nextState) => setState(nextState)
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(sandboxAddon);
    terminal.open(hostRef.current);
    fitAddon.fit();
    sandboxAddon.connect({ sandboxId: bootstrap.sandboxId, sessionId: bootstrap.sessionName });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(hostRef.current);

    return () => {
      resizeObserver.disconnect();
      sandboxAddon.dispose();
      fitAddon.dispose();
      terminal.dispose();
    };
  }, [bootstrap]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Connection</span>
        <span className={state === 'connected' ? 'text-emerald-300' : state === 'connecting' ? 'text-cyan-300' : 'text-slate-500'}>
          {state}
        </span>
      </div>
      <div ref={hostRef} className="min-h-[18rem] rounded-xl border border-slate-900 bg-[#040812] p-2" />
    </div>
  );
}
