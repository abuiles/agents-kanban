import type { LlmAdapter } from './adapter';
import { LineLogBuffer } from '../line-log-buffer';
import { buildRunLog } from '../shared/real-run';
import type { Repo, RunCommand, RunCommandPhase, RunEvent } from '../../ui/domain/types';

const CURSOR_STREAM_INACTIVITY_TIMEOUT_MS = 120_000;
type LoggableRunPhase = NonNullable<ReturnType<typeof buildRunLog>['phase']>;
let parseSSEStreamFn: (<T>(stream: unknown) => AsyncIterable<T>) | undefined;

export const cursorCliLlmAdapter: LlmAdapter = {
  kind: 'cursor_cli',
  capabilities: {
    supportsResume: false,
    supportsTakeover: false
  },

  async ensureInstalled(context) {
    const result = await emitCommandLifecycle(
      context.repoBoard,
      context.runId,
      'codex',
      `bash -lc ${shellQuote(`set -euo pipefail
if command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1; then
  exit 0
fi
if command -v npm >/dev/null 2>&1; then
  npm install -g @cursor/cli
fi
command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1
`)}`,
      () =>
        context.sandbox.exec(
          `bash -lc ${shellQuote(`set -euo pipefail
if command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1; then
  exit 0
fi
if command -v npm >/dev/null 2>&1; then
  npm install -g @cursor/cli
fi
command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1
`)}`
        )
    );
    if (!result.success) {
      throw await createNonRetryableError('Cursor CLI is not available in the sandbox.');
    }
  },

  async restoreAuth(context) {
    const env = context.env as Env & { RUN_ARTIFACTS?: R2Bucket; SECRETS_KV?: KVNamespace };
    const authBundleKey = await resolveCursorAuthBundleKey(env, context.repo);
    if (!authBundleKey) {
      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(context.runId, 'No Cursor CLI auth bundle is configured. Assuming the sandbox image already has Cursor credentials.', 'bootstrap')
      ]);
      return;
    }
    if (!env.RUN_ARTIFACTS) {
      throw await createNonRetryableError('RUN_ARTIFACTS binding is not configured for Cursor auth restore.');
    }

    const object = await env.RUN_ARTIFACTS.get(authBundleKey);
    if (!object) {
      throw await createNonRetryableError(`Cursor auth bundle ${authBundleKey} was not found in R2.`);
    }

    const archiveBase64 = bytesToBase64(await object.arrayBuffer());
    await context.sandbox.writeFile('/workspace/cursor-auth.tgz.b64', archiveBase64);
    const restoreResult = await emitCommandLifecycle(
      context.repoBoard,
      context.runId,
      'bootstrap',
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
base64 -d /workspace/cursor-auth.tgz.b64 > /workspace/cursor-auth.tgz
mkdir -p "$HOME"
tar -xzf /workspace/cursor-auth.tgz -C "$HOME"
`)}`,
      () =>
        context.sandbox.exec(
          `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
base64 -d /workspace/cursor-auth.tgz.b64 > /workspace/cursor-auth.tgz
mkdir -p "$HOME"
tar -xzf /workspace/cursor-auth.tgz -C "$HOME"
`)}`
        )
    );
    if (!restoreResult.success) {
      throw await createNonRetryableError('Cursor auth bundle restore failed.');
    }
  },

  async logDiagnostics(context, request) {
    const diagnostics = await emitCommandLifecycle(
      context.repoBoard,
      context.runId,
      'codex',
      `bash -lc ${shellQuote(`set -euo pipefail
if command -v cursor-agent >/dev/null 2>&1; then
  CURSOR_BIN="cursor-agent"
elif command -v cursor >/dev/null 2>&1; then
  CURSOR_BIN="cursor"
else
  echo "Cursor CLI is not installed." >&2
  exit 127
fi
"$CURSOR_BIN" --version
printf 'Cursor model: ${request.model}\\n'
printf 'Cursor reasoning effort: ${request.reasoningEffort ?? 'medium'}\\n'
`)}`,
      () =>
        context.sandbox.exec(
          `bash -lc ${shellQuote(`set -euo pipefail
if command -v cursor-agent >/dev/null 2>&1; then
  CURSOR_BIN="cursor-agent"
elif command -v cursor >/dev/null 2>&1; then
  CURSOR_BIN="cursor"
else
  echo "Cursor CLI is not installed." >&2
  exit 127
fi
"$CURSOR_BIN" --version
printf 'Cursor model: ${request.model}\\n'
printf 'Cursor reasoning effort: ${request.reasoningEffort ?? 'medium'}\\n'
`)}`
        )
    );
    if (!diagnostics.success) {
      throw await createNonRetryableError('Cursor diagnostics failed because the CLI is unavailable.');
    }
  },

  async run(context, request) {
    await context.sandbox.writeFile('/workspace/task.txt', request.prompt);
    const command = `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
cd ${request.cwd}
if command -v cursor-agent >/dev/null 2>&1; then
  CURSOR_BIN="cursor-agent"
elif command -v cursor >/dev/null 2>&1; then
  CURSOR_BIN="cursor"
else
  echo "Cursor CLI is not installed." >&2
  exit 127
fi
PROMPT="$(cat /workspace/task.txt)"
"$CURSOR_BIN" -p --force --output-format text --model ${shellQuote(request.model)} "$PROMPT"
`)}`;
    return runCursorProcessWithLogs(context, command);
  },

  async runPrompt(context, request) {
    const startedAt = Date.now();
    const timeoutSeconds = Math.max(1, Math.ceil((request.timeoutMs ?? 45_000) / 1000));
    await context.sandbox.writeFile('/workspace/prompt.txt', request.prompt);
    const command = `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
mkdir -p ${request.cwd}
cd ${request.cwd}
if command -v cursor-agent >/dev/null 2>&1; then
  CURSOR_BIN="cursor-agent"
elif command -v cursor >/dev/null 2>&1; then
  CURSOR_BIN="cursor"
else
  echo "Cursor CLI is not installed." >&2
  exit 127
fi
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout ${timeoutSeconds}s "$@"
  else
    "$@"
  fi
}
PROMPT="$(cat /workspace/prompt.txt)"
run_with_timeout "$CURSOR_BIN" -p --force --output-format text --model ${shellQuote(request.model)} "$PROMPT"
`)}`;
    const phase = request.phase ?? 'preview';
    const result = await emitCommandLifecycle(
      context.repoBoard,
      context.runId,
      phase,
      command,
      () => context.sandbox.exec(command)
    );
    const elapsedMs = Date.now() - startedAt;
    const rawOutput = result.stdout?.trim();

    if (result.exitCode === 124) {
      return {
        status: 'timed_out',
        elapsedMs,
        timeoutMs: request.timeoutMs ?? 45_000,
        rawOutput,
        stderr: result.stderr
      };
    }

    if (!result.success) {
      return {
        status: 'failed',
        elapsedMs,
        message: result.stderr?.trim() || 'Cursor CLI prompt execution failed.',
        rawOutput,
        stderr: result.stderr
      };
    }

    return {
      status: 'success',
      elapsedMs,
      rawOutput: rawOutput ?? '',
      stderr: result.stderr
    };
  }
};

async function runCursorProcessWithLogs(context: Parameters<LlmAdapter['run']>[0], command: string) {
  const { sandbox, repoBoard, runId } = context;
  const phase: RunCommandPhase = 'codex';
  const commandId = buildRunCommandId(runId, phase);
  const run = await repoBoard.getRun(runId);
  const startedAt = new Date().toISOString();
  const stdoutBuffer = new LineLogBuffer();
  const stderrBuffer = new LineLogBuffer();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 1;
  let streamError: string | undefined;
  let appendQueue = Promise.resolve();
  let lastStreamEventAt = Date.now();

  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase,
    startedAt,
    status: 'running',
    command,
    source: 'system'
  }]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(run, 'workflow', 'command.started', `Started ${phase} command.`, { commandId, phase })
  ]);

  const enqueueLogs = (logs: Array<{ message: string; level: 'info' | 'error' }>) => {
    if (!logs.length) {
      return;
    }
    appendQueue = appendQueue.then(() =>
      repoBoard.appendRunLogs(
        runId,
        logs.map((log) => buildRunLog(runId, log.message, phase, log.level))
      )
    );
  };

  const process = await sandbox.startProcess(command);
  const stream = await sandbox.streamProcessLogs(process.id);
  const parseSSEStream = await getParseSSEStream();
  const iterator = parseSSEStream<Record<string, unknown>>(stream)[Symbol.asyncIterator]();

  try {
    while (true) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<Record<string, unknown>>>((_, reject) =>
          setTimeout(() => reject(new Error('CURSOR_STREAM_IDLE_TIMEOUT')), CURSOR_STREAM_INACTIVITY_TIMEOUT_MS)
        )
      ]);
      if (next.done) {
        break;
      }

      const event = next.value;
      lastStreamEventAt = Date.now();
      const eventType = typeof event.type === 'string' ? event.type : '';
      switch (eventType) {
        case 'stdout': {
          const chunk = typeof event.data === 'string' ? event.data : '';
          stdoutChunks.push(chunk);
          enqueueLogs(stdoutBuffer.push(chunk).map((message) => ({ message, level: 'info' as const })));
          break;
        }
        case 'stderr': {
          const chunk = typeof event.data === 'string' ? event.data : '';
          stderrChunks.push(chunk);
          enqueueLogs(stderrBuffer.push(chunk).map((message) => ({ message, level: 'error' as const })));
          break;
        }
        case 'exit':
        case 'complete':
          exitCode = typeof event.exitCode === 'number' ? event.exitCode : exitCode;
          break;
        case 'error':
          streamError = typeof event.error === 'string' ? event.error : 'Cursor command stream failed.';
          break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CURSOR_STREAM_IDLE_TIMEOUT') {
      const idleMs = Date.now() - lastStreamEventAt;
      streamError = `Cursor stream inactivity timeout after ${Math.floor(idleMs / 1000)}s without events.`;
      try {
        await sandbox.killProcess(process.id);
      } catch {
        // best effort
      }
      await repoBoard.appendRunLogs(runId, [
        buildRunLog(runId, `${streamError} Killed Cursor process and failing run for retry.`, phase, 'error')
      ]);
    } else {
      throw error;
    }
  } finally {
    enqueueLogs(stdoutBuffer.flush().map((message) => ({ message, level: 'info' as const })));
    enqueueLogs(stderrBuffer.flush().map((message) => ({ message, level: 'error' as const })));
    await appendQueue;
  }

  const latestRun = await repoBoard.getRun(runId);
  const stoppedForTakeover = latestRun.status === 'OPERATOR_CONTROLLED';
  const stdout = stdoutChunks.join('');
  const stderr = [stderrChunks.join(''), streamError].filter(Boolean).join(stderrChunks.length ? '\n' : '');
  const success = !streamError && exitCode === 0;

  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode,
    status: success || stoppedForTakeover ? 'completed' : 'failed',
    command,
    source: 'system',
    stdoutPreview: summarizeOutput(stdout),
    stderrPreview: summarizeOutput(stderr)
  }]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(
      await repoBoard.getRun(runId),
      stoppedForTakeover ? 'operator' : success ? 'workflow' : 'system',
      'command.completed',
      stoppedForTakeover
        ? `Stopped ${phase} command after operator takeover.`
        : `Completed ${phase} command with exit code ${exitCode}.`,
      {
        commandId,
        phase,
        exitCode,
        success,
        stoppedForTakeover
      }
    )
  ]);

  return {
    success,
    stdout,
    stderr,
    stoppedForTakeover
  };
}

async function emitCommandLifecycle(
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard'],
  runId: string,
  phase: LoggableRunPhase,
  command: string,
  execute: () => Promise<{ success: boolean; exitCode: number; stdout?: string; stderr?: string }>
) {
  const run = await repoBoard.getRun(runId);
  const commandId = buildRunCommandId(runId, phase);
  const startedAt = new Date().toISOString();
  const startedCommand: RunCommand = {
    id: commandId,
    runId,
    phase,
    startedAt,
    status: 'running',
    command,
    source: 'system'
  };
  await repoBoard.upsertRunCommands(runId, [startedCommand]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(run, 'workflow', 'command.started', `Started ${phase} command.`, { commandId, phase })
  ]);

  const result = await execute();
  const completedRun = await repoBoard.getRun(runId);
  const completedCommand: RunCommand = {
    ...startedCommand,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    status: result.success ? 'completed' : 'failed',
    stdoutPreview: summarizeOutput(result.stdout),
    stderrPreview: summarizeOutput(result.stderr)
  };
  await repoBoard.upsertRunCommands(runId, [completedCommand]);
  await repoBoard.appendRunEvents(runId, [
    buildRunEvent(
      completedRun,
      result.success ? 'workflow' : 'system',
      'command.completed',
      `Completed ${phase} command with exit code ${result.exitCode}.`,
      { commandId, phase, exitCode: result.exitCode, success: result.success }
    )
  ]);
  await appendCommandLogs(repoBoard, runId, phase, result.stdout, result.stderr);
  return result;
}

async function appendCommandLogs(
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard'],
  runId: string,
  phase: LoggableRunPhase,
  stdout?: string,
  stderr?: string
) {
  const logs = [];
  if (stdout?.trim()) logs.push(buildRunLog(runId, stdout.trim(), phase));
  if (stderr?.trim()) logs.push(buildRunLog(runId, stderr.trim(), phase, 'error'));
  if (logs.length) await repoBoard.appendRunLogs(runId, logs);
}

function summarizeOutput(output?: string) {
  if (!output?.trim()) {
    return undefined;
  }

  const compact = output.trim().replace(/\s+/g, ' ');
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function buildRunCommandId(runId: string, phase: RunCommandPhase) {
  return `${runId}_${phase}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildRunEvent(
  run: Awaited<ReturnType<Parameters<LlmAdapter['run']>[0]['repoBoard']['getRun']>>,
  actorType: RunEvent['actorType'],
  eventType: RunEvent['eventType'],
  message: string,
  metadata?: Record<string, string | number | boolean>
): RunEvent {
  const at = new Date().toISOString();
  return {
    id: `${run.runId}_${eventType}_${at}_${Math.random().toString(36).slice(2, 8)}`,
    runId: run.runId,
    repoId: run.repoId,
    taskId: run.taskId,
    at,
    actorType,
    eventType,
    message,
    metadata
  };
}

async function getParseSSEStream() {
  if (parseSSEStreamFn) {
    return parseSSEStreamFn;
  }
  const sandbox = await import('@cloudflare/sandbox');
  parseSSEStreamFn = sandbox.parseSSEStream as <T>(stream: unknown) => AsyncIterable<T>;
  return parseSSEStreamFn;
}

async function resolveCursorAuthBundleKey(env: Env & { SECRETS_KV?: KVNamespace }, repo: Repo) {
  const fromRepo =
    (repo as Repo & { cursorCliAuthBundleR2Key?: string }).cursorCliAuthBundleR2Key
    ?? (repo as Repo & { cursorAuthBundleR2Key?: string }).cursorAuthBundleR2Key;
  if (fromRepo) {
    return fromRepo;
  }
  const fromPrimaryKey = await env.SECRETS_KV?.get('cursor_cli_auth_bundle_r2_key');
  if (fromPrimaryKey) {
    return fromPrimaryKey;
  }
  return env.SECRETS_KV?.get('cursor_auth_bundle_r2_key');
}

function bytesToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function createNonRetryableError(message: string): Promise<Error> {
  try {
    const workflowImportPath = ['cloudflare', 'workflows'].join(':');
    const workflows = await import(/* @vite-ignore */ workflowImportPath);
    return new workflows.NonRetryableError(message);
  } catch {
    const error = new Error(message);
    error.name = 'NonRetryableError';
    return error;
  }
}
