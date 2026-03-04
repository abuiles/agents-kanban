#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';

type TunnelMode = 'off' | 'auto' | 'external';

const DEV_PORT = process.env.AK_DEV_PORT?.trim() || '5173';
const LOCAL_DEV_URL = `http://localhost:${DEV_PORT}`;
const externalUrl = process.env.AK_DEV_PUBLIC_URL?.trim();
const cloudflaredTunnelName = process.env.AK_DEV_CLOUDFLARED_TUNNEL?.trim() || 'ab-1';
const mode = resolveTunnelMode(process.env.AK_DEV_TUNNEL, externalUrl);

let viteProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | null = null;
let shuttingDown = false;
let discoveredTunnelUrl: string | undefined;

function normalizeMode(value: string | undefined): TunnelMode {
  const normalized = (value ?? 'off').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'external' || normalized === 'off') {
    return normalized;
  }
  return 'auto';
}

function log(message: string) {
  process.stdout.write(`[dev] ${message}\n`);
}

function warn(message: string) {
  process.stderr.write(`[dev] ${message}\n`);
}

function resolveCommand(binary: string) {
  if (platform() === 'win32') {
    return `${binary}.cmd`;
  }
  return binary;
}

function hasCloudflaredBinary() {
  const probe = spawnSync(resolveCommand('cloudflared'), ['--version'], {
    stdio: 'ignore',
    env: process.env
  });
  return probe.status === 0;
}

function resolveTunnelMode(rawMode: string | undefined, publicUrl: string | undefined): TunnelMode {
  if (typeof rawMode === 'string' && rawMode.trim()) {
    return normalizeMode(rawMode);
  }
  if (publicUrl) {
    return 'external';
  }
  if (hasCloudflaredBinary()) {
    return 'auto';
  }
  return 'off';
}

function extractTryCloudflareUrl(text: string) {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0];
}

function killProcess(child: ChildProcess | null) {
  if (!child || child.killed) {
    return;
  }
  child.kill('SIGTERM');
}

function startVite() {
  const command = resolveCommand('vite');
  viteProcess = spawn(command, ['--host', '0.0.0.0', '--port', DEV_PORT], {
    stdio: 'inherit',
    env: process.env
  });

  viteProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (signal) {
      warn(`Vite exited from signal ${signal}.`);
    } else {
      warn(`Vite exited with code ${code ?? 0}.`);
    }
    killProcess(tunnelProcess);
    process.exit(code ?? 0);
  });
}

function startTunnelAuto() {
  const command = resolveCommand('cloudflared');
  tunnelProcess = spawn(command, ['tunnel', 'run', cloudflaredTunnelName], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  const onTunnelOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(`[tunnel] ${text}`);
    const url = extractTryCloudflareUrl(text);
    if (url && discoveredTunnelUrl !== url) {
      discoveredTunnelUrl = url;
      log(`Public tunnel URL detected: ${url}`);
      log(`Use this in Slack/GitHub webhooks: ${url}`);
    }
  };

  tunnelProcess.stdout?.on('data', onTunnelOutput);
  tunnelProcess.stderr?.on('data', onTunnelOutput);

  tunnelProcess.on('error', (error) => {
    warn(`Failed to start cloudflared: ${error.message}`);
    warn('Install cloudflared or run with AK_DEV_TUNNEL=off / AK_DEV_TUNNEL=external.');
  });

  tunnelProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (signal) {
      warn(`Tunnel exited from signal ${signal}.`);
    } else {
      warn(`Tunnel exited with code ${code ?? 0}.`);
    }
  });
}

function printBanner() {
  log(`Starting local dev server on ${LOCAL_DEV_URL}`);
  if (!process.env.AK_DEV_TUNNEL?.trim()) {
    log('Tunnel mode selected automatically (override with AK_DEV_TUNNEL=off|auto|external).');
  }
  if (mode === 'off') {
    log('Tunnel mode: off');
    log('To enable auto tunnel: AK_DEV_TUNNEL=auto yarn dev');
    return;
  }
  if (mode === 'external') {
    log('Tunnel mode: external');
    if (externalUrl) {
      log(`External public URL: ${externalUrl}`);
      log(`Use this in Slack/GitHub webhooks: ${externalUrl}`);
    } else {
      warn('AK_DEV_TUNNEL=external set but AK_DEV_PUBLIC_URL is missing.');
    }
    return;
  }
  log(`Tunnel mode: auto (cloudflared, tunnel=${cloudflaredTunnelName})`);
}

function start() {
  printBanner();
  startVite();
  if (mode === 'auto') {
    startTunnelAuto();
  }
}

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`Received ${signal}, shutting down...`);
  killProcess(tunnelProcess);
  killProcess(viteProcess);
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
