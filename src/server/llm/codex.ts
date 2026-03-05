import type { RunCommand, RunCommandPhase, RunEvent } from '../../ui/domain/types';
import { LineLogBuffer } from '../line-log-buffer';
import { buildRunLog } from '../shared/real-run';
import {
  formatCodexRateLimitSnapshot,
  getCodexCapacityDecision,
  type CodexRateLimitsResponse
} from '../codex-rate-limit';
import type { LlmAdapter } from './adapter';
import { redactSensitiveText } from '../security/redaction';

const CODEX_STREAM_INACTIVITY_TIMEOUT_MS = 120_000;
const CODEX_APPSERVER_UNAVAILABLE_MARKER = 'CODEX_APP_SERVER_UNAVAILABLE';
const CODEX_APPSERVER_LAST_MESSAGE_MARKER = '===CODEX_LAST_MESSAGE===';
const CODEX_APPSERVER_RUNNER_PATH = '/workspace/codex-app-server.mjs';
let parseSSEStreamFn: (<T>(stream: unknown) => AsyncIterable<T>) | undefined;

const CODEX_APPSERVER_RUNNER = codexAppServerRunnerSource();

function codexAppServerRunnerSource() {
  const lines = [
    'import fs from "node:fs";',
    'import { spawn } from "node:child_process";',
    '',
    'const CODEX_APPSERVER_UNAVAILABLE_MARKER = "CODEX_APP_SERVER_UNAVAILABLE";',
    'const CODEX_APPSERVER_LAST_MESSAGE_MARKER = "===CODEX_LAST_MESSAGE===";',
    '',
    'function fail(message) {',
    '  process.stderr.write(String(message) + "\\n");',
    '  process.exit(1);',
    '}',
    '',
    'const configText = process.argv[2];',
    'if (!configText) {',
    '  fail(CODEX_APPSERVER_UNAVAILABLE_MARKER + ": Missing codex app-server config.");',
    '}',
    '',
    'let config;',
    'try {',
    '  config = JSON.parse(configText);',
    '} catch (error) {',
    '  fail(',
    '    CODEX_APPSERVER_UNAVAILABLE_MARKER',
    '    + ": Could not parse codex app-server config. "',
    '    + (error instanceof Error ? error.message : String(error))',
    '  );',
    '}',
    '',
    'const mode = config.mode;',
    'const cwd = config.cwd;',
    'const model = config.model;',
    'const reasoningEffort = config.reasoningEffort || "medium";',
    'const promptPath = config.promptPath;',
    'const outputSchemaPath = config.outputSchemaPath;',
    'const outputLastMessagePath = config.outputLastMessagePath;',
    'const timeoutMs = Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : undefined;',
    '',
    'if (!mode || !cwd || !model || !promptPath) {',
    '  fail(CODEX_APPSERVER_UNAVAILABLE_MARKER + ": Missing required app-server parameters.");',
    '}',
    '',
    'const promptText = (() => {',
    '  if (!fs.existsSync(promptPath)) {',
    '    fail(CODEX_APPSERVER_UNAVAILABLE_MARKER + ": Prompt file is missing at " + promptPath + ".");',
    '  }',
    '  return fs.readFileSync(promptPath, "utf8");',
    '})();',
    '',
    'function outputLastMessage(value) {',
    '  if (!outputLastMessagePath) {',
    '    return;',
    '  }',
    '  const normalized = typeof value === "string" ? value : JSON.stringify(value, null, 2);',
    '  fs.writeFileSync(outputLastMessagePath, normalized || "", "utf8");',
    '  process.stdout.write("\\n" + CODEX_APPSERVER_LAST_MESSAGE_MARKER + "\\n" + (normalized || "") + "\\n");',
    '}',
    '',
    'function extractText(value) {',
    '  if (typeof value === "string") {',
    '    return value;',
    '  }',
    '  if (value && typeof value === "object") {',
    '    if (typeof value.output === "string") return value.output;',
    '    if (typeof value.message === "string") return value.message;',
    '    if (typeof value.content === "string") return value.content;',
    '    if (typeof value.text === "string") return value.text;',
    '    if (typeof value.result === "string") return value.result;',
    '    if (typeof value.value === "string") return value.value;',
    '    if (Array.isArray(value.items) && value.items.every((item) => typeof item === "string")) {',
    '      return value.items.join("\\n");',
    '    }',
    '  }',
    '  return undefined;',
    '}',
    '',
    'function normalizeResumeCommand(value) {',
    '  if (!value || typeof value !== "string") {',
    '    return undefined;',
    '  }',
    '  return value.startsWith("codex resume ") ? value : ("codex resume " + value);',
    '}',
    '',
    'function extractField(value, keys) {',
    '  if (!value || typeof value !== "object") {',
    '    return undefined;',
    '  }',
    '  for (const key of keys) {',
    '    if (typeof value[key] === "string") {',
    '      return value[key];',
    '    }',
    '    if (value[key] && typeof value[key] === "object" && typeof value[key]?.id === "string") {',
    '      return value[key].id;',
    '    }',
    '  }',
    '  return undefined;',
    '}',
    '',
    'function createMessageParser() {',
    '  let buffered = "";',
    '  const pending = new Map();',
    '  let nextId = 1;',
    '  let isReady = false;',
    '  let resolveInitialize;',
    '',
    '  const requestTimeoutMs = Math.max(5000, Math.min(timeoutMs ?? 45000, 120000));',
    '  const child = spawn("codex", ["app-server"], {',
    '    stdio: ["pipe", "pipe", "pipe"]',
    '  });',
    '',
    '  function finish(error) {',
    '    if (error) {',
    '      fail(CODEX_APPSERVER_UNAVAILABLE_MARKER + ": " + String(error));',
    '    }',
    '  }',
    '',
    '  child.on("error", (error) => {',
    '    finish(error?.message ? String(error.message) : "failed to spawn codex app-server");',
    '  });',
    '',
    '  child.stderr.on("data", (chunk) => process.stderr.write(chunk));',
    '',
    '  const next = () => {',
    '    const id = nextId += 1;',
    '    return id;',
    '  };',
    '',
    '  const send = (method, params) => {',
    '    const id = next();',
    '    const request = {',
    '      jsonrpc: "2.0",',
    '      id,',
    '      method,',
    '      params',
    '    };',
    '    child.stdin.write(JSON.stringify(request) + "\\n");',
    '',
    '    return new Promise((resolve, reject) => {',
    '      const timer = setTimeout(() => {',
    '        pending.delete(id);',
    '        reject(new Error(method + " timed out after " + requestTimeoutMs + "ms"));',
    '      }, requestTimeoutMs);',
    '      pending.set(id, { resolve, reject, timer, method });',
    '    });',
    '  };',
    '',
    '  const handleResponse = (value) => {',
    '    if (value && typeof value === "object" && typeof value.id === "number" && pending.has(value.id)) {',
    '      const waiter = pending.get(value.id);',
    '      pending.delete(value.id);',
    '      clearTimeout(waiter.timer);',
    '      if (value.error) {',
    '        waiter.reject(new Error(value.error.message ?? JSON.stringify(value.error)));',
    '        return;',
    '      }',
    '      waiter.resolve(value.result ?? value);',
    '      return;',
    '    }',
    '',
    '    if (value?.method === "stdout") {',
    '      const text = typeof value.params === "string" ? value.params : typeof value.message === "string" ? value.message : "";',
    '      if (text) {',
    '        process.stdout.write(String(text) + "\\n");',
    '      }',
    '      return;',
    '    }',
    '',
    '    if (value?.method === "stderr") {',
    '      const text = typeof value.params === "string" ? value.params : typeof value.message === "string" ? value.message : "";',
    '      if (text) {',
    '        process.stderr.write(String(text) + "\\n");',
    '      }',
    '    }',
    '  };',
    '',
    '  child.stdout.on("data", (chunk) => {',
    '    buffered += chunk.toString();',
    '    while (true) {',
    '      const newlineIndex = buffered.indexOf("\\n");',
    '      if (newlineIndex < 0) {',
    '        break;',
    '      }',
    '      const line = buffered.slice(0, newlineIndex).trim();',
    '      buffered = buffered.slice(newlineIndex + 1);',
    '      if (!line) {',
    '        continue;',
    '      }',
    '      let message;',
    '      try {',
    '        message = JSON.parse(line);',
    '      } catch {',
    '        process.stdout.write(line + "\\n");',
    '        continue;',
    '      }',
    '      handleResponse(message);',
    '      if (isReady === false && message && typeof message.id === "number" && message.result) {',
    '        resolveInitialize?.();',
    '        isReady = true;',
    '      }',
    '    }',
    '  });',
    '',
    '  return {',
    '    send,',
    '    waitForReady: () =>',
    '      new Promise((resolve, reject) => {',
    '        const timeout = setTimeout(() => {',
    '          reject(new Error("codex app-server did not initialize in time."));',
    '        }, requestTimeoutMs);',
    '        resolveInitialize = () => {',
    '          clearTimeout(timeout);',
    '          resolve();',
    '        };',
    '      }),',
    '    child,',
    '    handleExit: async () => {',
    '      const exitCode = await new Promise((resolve) => {',
    '        child.once("exit", (code) => resolve(code));',
    '      });',
    '      if (exitCode !== 0) {',
    '        fail(CODEX_APPSERVER_UNAVAILABLE_MARKER + ": codex app-server exited with code " + String(exitCode) + ".");',
    '      }',
    '    }',
    '  };',
    '}',
    '',
    'async function runViaAppServer() {',
    '  const protocol = createMessageParser();',
    '',
    '  protocol.child.stdin.write(',
    '    JSON.stringify({',
    '      jsonrpc: "2.0",',
    '      id: 1,',
    '      method: "initialize",',
    '      params: { apiVersion: 2, clientInfo: { name: "agentskanban-codex-runner", version: "1.0.0" } }',
    '    }) + "\\n"',
    '  );',
    '  await protocol.waitForReady();',
    '',
    '  const threadResult = await protocol.send("thread/start", {',
    '    projectPath: cwd,',
    '    model,',
    '    reasoningEffort,',
    '    skipGitRepoCheck: true',
    '  });',
    '  const threadId = extractField(threadResult, ["thread_id", "threadId", "id", "thread"]) || extractField(threadResult?.thread, ["id"]) || undefined;',
    '  const threadResume = normalizeResumeCommand(extractField(threadResult, ["resume_command", "resumeCommand", "resume"]));',
    '',
    '  if (threadId) {',
    '    process.stdout.write("{\"thread_id\":\"" + threadId + "\"}\\n");',
    '  }',
    '  if (threadResume) {',
    '    process.stdout.write("Use this to continue later: " + threadResume + "\\n");',
    '  }',
    '',
    '  const outputSchema = outputSchemaPath && fs.existsSync(outputSchemaPath)',
    '    ? JSON.parse(fs.readFileSync(outputSchemaPath, "utf8"))',
    '    : undefined;',
    '',
    '  const turnParams = {',
    '    thread_id: threadId,',
    '    prompt: promptText,',
    '    model,',
    '    reasoningEffort,',
    '    isEphemeral: mode === "prompt",',
    '    skipGitRepoCheck: true,',
    '    ...(outputSchema ? { outputSchema } : {})',
    '  };',
    '',
    '  const turnResult = await protocol.send("turn/start", turnParams);',
    '  const responseText = extractText(turnResult);',
    '  const turnResume = normalizeResumeCommand(extractField(turnResult, ["resume_command", "resumeCommand", "resume"]));',
    '  const resumeText = turnResume || threadResume;',
    '',
    '  if (resumeText && !responseText?.includes("codex resume")) {',
    '    process.stdout.write("Use this to continue later: " + resumeText + "\\n");',
    '  }',
    '',
    '  outputLastMessage(responseText || JSON.stringify(turnResult, null, 2));',
    '  if (responseText) {',
    '    process.stdout.write(String(responseText) + "\\n");',
    '  }',
    '  protocol.child.stdin.end();',
    '  await protocol.handleExit();',
    '}',
    '',
    'runViaAppServer().catch((error) => {',
    '  fail(CODEX_APPSERVER_UNAVAILABLE_MARKER + ": " + (error instanceof Error ? error.message : String(error)));',
    '});',
    ''
  ];
  return lines.join("\n");
}

export const codexLlmAdapter: LlmAdapter = {
  kind: 'codex',
  capabilities: {
    supportsResume: true,
    supportsTakeover: true,
    resumeCommandLabel: 'Codex resume command'
  },

  async ensureInstalled(context) {
    await emitCommandLifecycle(
      context.repoBoard,
      context.runId,
      'codex',
      "bash -lc 'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex'",
      () => context.sandbox.exec("bash -lc 'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex'")
    );
  },

  async restoreAuth(context) {
    const env = context.env as Env & { RUN_ARTIFACTS?: R2Bucket; CODEX_AUTH_BUNDLE_R2_KEY?: string };
    const { sandbox, repoBoard, runId } = context;
    const authBundleKey = env.CODEX_AUTH_BUNDLE_R2_KEY?.trim();

    if (!authBundleKey || !env.RUN_ARTIFACTS) {
      const reason = !authBundleKey
        ? 'No global CODEX_AUTH_BUNDLE_R2_KEY is configured.'
        : 'RUN_ARTIFACTS binding is not configured.';
      await repoBoard.appendRunLogs(runId, [buildRunLog(runId, reason, 'bootstrap', 'error')]);
      throw await createNonRetryableError(reason);
    }

    const object = await env.RUN_ARTIFACTS.get(authBundleKey);
    if (!object) {
      await repoBoard.appendRunLogs(runId, [buildRunLog(runId, `Codex auth bundle ${authBundleKey} was not found in R2.`, 'bootstrap', 'error')]);
      throw await createNonRetryableError(`Codex auth bundle ${authBundleKey} was not found in R2.`);
    }

    const archiveBase64 = bytesToBase64(await object.arrayBuffer());
    await sandbox.writeFile('/workspace/codex-auth.tgz.b64', archiveBase64);
    const restoreResult = await sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
base64 -d /workspace/codex-auth.tgz.b64 > /workspace/codex-auth.tgz
mkdir -p "$HOME"
tar -xzf /workspace/codex-auth.tgz -C "$HOME"
test -d "$HOME/.codex"
ls -1 "$HOME/.codex" | sort | head -n 40
`)}`
    );
    await appendCommandLogs(repoBoard, runId, 'bootstrap', restoreResult.stdout, restoreResult.stderr);
    if (!restoreResult.success) {
      throw await createNonRetryableError('Codex auth bundle restore failed.');
    }

    const mcpConfig = await sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
CONFIG_DIR="$HOME/.codex"
CONFIG_FILE="$CONFIG_DIR/config.toml"
mkdir -p "$CONFIG_DIR"
touch "$CONFIG_FILE"

if ! grep -Fq "[mcp_servers.cloudflare-doc-mcp]" "$CONFIG_FILE"; then
  printf '\\n[mcp_servers.cloudflare-doc-mcp]\\nurl="https://docs.mcp.cloudflare.com/mcp"\\n' >> "$CONFIG_FILE"
fi

echo "Codex config file: $CONFIG_FILE"
if grep -Fq "[mcp_servers.cloudflare-doc-mcp]" "$CONFIG_FILE"; then
  echo "Cloudflare MCP: configured"
else
  echo "Cloudflare MCP: missing"
fi
`)}`
    );
    await appendCommandLogs(repoBoard, runId, 'bootstrap', mcpConfig.stdout, mcpConfig.stderr);
    if (!mcpConfig.success || !(mcpConfig.stdout ?? '').includes('Cloudflare MCP: configured')) {
      throw await createNonRetryableError('Cloudflare MCP configuration failed in sandbox.');
    }

    await logCodexAuthDiagnostics(sandbox, runId, repoBoard);
  },

  async logDiagnostics(context, request) {
    const diagnostics = await context.sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
command -v codex
codex --version
printf 'Codex model: ${request.model}\\n'
printf 'Codex reasoning effort: ${request.reasoningEffort ?? 'medium'}\\n'
`)}`
    );
    await appendCommandLogs(context.repoBoard, context.runId, 'codex', diagnostics.stdout, diagnostics.stderr);
    if (!diagnostics.success) {
      throw await createNonRetryableError('Codex CLI is not available in the sandbox.');
    }
  },

  async waitForCapacityIfNeeded(context, request, sleepFn) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const payload = await readCodexRateLimits(context.sandbox, context.repoBoard, context.runId);
      if (!payload) {
        return;
      }

      const decision = getCodexCapacityDecision(payload, request.model, Date.now());
      if (!decision.snapshot) {
        await context.repoBoard.appendRunLogs(context.runId, [
          buildRunLog(context.runId, 'Codex usage preflight did not return a usable rate-limit snapshot. Continuing without waiting.', 'codex')
        ]);
        return;
      }

      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(context.runId, formatCodexRateLimitSnapshot(decision.snapshot), 'codex')
      ]);

      if (!decision.shouldWait || !decision.waitMs) {
        return;
      }

      await context.repoBoard.transitionRun(context.runId, {
        status: 'BOOTSTRAPPING',
        appendTimelineNote: 'Waiting for Codex rate limits to reset before starting execution.'
      });
      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(context.runId, `${decision.reason} Sleeping until Codex budget resets.`, 'codex', 'error')
      ]);
      await sleepFn(`codex-budget-${attempt}`, Math.max(1_000, decision.waitMs));
      await context.repoBoard.transitionRun(context.runId, {
        status: 'RUNNING_CODEX',
        appendTimelineNote: 'Codex rate-limit wait completed. Rechecking execution budget.'
      });
    }
  },

  async run(context, request) {
    await context.sandbox.writeFile('/workspace/task.txt', request.prompt);
    const appServerResult = await runCodexAppServer(context, {
      mode: 'run',
      cwd: request.cwd,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      promptPath: '/workspace/task.txt'
    });

    if (shouldFallbackToLegacyCodexCli(appServerResult)) {
      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(
          context.runId,
          'CODEX_APP_SERVER_UNAVAILABLE: Falling back to direct codex exec for run() because app-server execution was unavailable.',
          'codex'
        )
      ]);
      return runCodexLegacy(context, request);
    }

    return appServerResult;
  },

  async runPrompt(context, request) {
    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? 45_000;
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const phase = request.phase ?? 'preview';
    await context.sandbox.writeFile('/workspace/prompt.txt', request.prompt);
    if (request.outputSchema) {
      await context.sandbox.writeFile('/workspace/prompt-output-schema.json', JSON.stringify(request.outputSchema, null, 2));
    }

    const appServerResult = await runCodexPromptViaAppServer(context, {
      phase,
      cwd: request.cwd,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      timeoutMs,
      timeoutSeconds,
      outputSchemaPath: request.outputSchema ? '/workspace/prompt-output-schema.json' : undefined
    });
    if (appServerResult.handledByFallback) {
      await context.repoBoard.appendRunLogs(context.runId, [
        buildRunLog(
          context.runId,
          'CODEX_APP_SERVER_UNAVAILABLE: Falling back to direct codex exec for prompt() because app-server execution was unavailable.',
          'codex'
        )
      ]);
      const command = buildCodexLegacyPromptCommand({
        cwd: request.cwd,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        timeoutSeconds,
        outputSchema: request.outputSchema
      });
      const fallbackResult = await emitCommandLifecycle(
        context.repoBoard,
        context.runId,
        phase,
        redactSensitiveText(command),
        () => context.sandbox.exec(command)
      );
      return buildPromptResultFromExecResult({
        result: fallbackResult,
        startedAt,
        timeoutMs
      });
    }

    return buildPromptResultFromExecResult({
      result: appServerResult.result,
      startedAt,
      timeoutMs
    });
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

type ManagedExecResult = {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode: number;
  stoppedForTakeover?: boolean;
};

type CodexPromptExecution = {
  result: ManagedExecResult;
  handledByFallback: boolean;
};

type CodexAppServerMode = 'run' | 'prompt';

type CodexAppServerCommandConfig = {
  mode: CodexAppServerMode;
  cwd: string;
  model: string;
  reasoningEffort: string;
  promptPath: string;
  outputLastMessagePath?: string;
  outputSchemaPath?: string;
  timeoutMs?: number;
};

function buildCodexLegacyRunCommand(request: Parameters<LlmAdapter['run']>[1]) {
  return `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
cd ${request.cwd}
cat /workspace/task.txt | codex exec -m ${request.model} -c model_reasoning_effort="${request.reasoningEffort ?? 'medium'}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C ${request.cwd} --json -
`)}`;
}

function buildCodexLegacyPromptCommand(options: {
  cwd: string;
  model: string;
  reasoningEffort?: string;
  timeoutSeconds: number;
  outputSchema?: Record<string, unknown>;
}) {
  const schemaArg = options.outputSchema ? '--output-schema /workspace/prompt-output-schema.json' : '';
  return `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
mkdir -p ${options.cwd}
cd ${options.cwd}
rm -f /workspace/prompt-last-message.txt
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout ${options.timeoutSeconds}s "$@"
  else
    "$@"
  fi
}
cat /workspace/prompt.txt | run_with_timeout codex exec -m ${options.model} -c model_reasoning_effort="${options.reasoningEffort ?? 'medium'}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral -C ${options.cwd} ${schemaArg} --output-last-message /workspace/prompt-last-message.txt -
if [ -f /workspace/prompt-last-message.txt ]; then
  printf '\n===CODEX_LAST_MESSAGE===\n'
  cat /workspace/prompt-last-message.txt
fi
`)}`;
}

async function runCodexLegacy(context: Parameters<LlmAdapter['run']>[0], request: Parameters<LlmAdapter['run']>[1]) {
  const command = buildCodexLegacyRunCommand(request);
  return runCodexProcessWithLogs(context, command);
}

async function runCodexPromptViaAppServer(
  context: Parameters<LlmAdapter['runPrompt']>[0],
  options: {
    phase: NonNullable<Parameters<LlmAdapter['runPrompt']>[1]['phase']>;
    cwd: string;
    model: string;
    reasoningEffort?: string;
    timeoutMs: number;
    timeoutSeconds: number;
    outputSchemaPath?: string;
  }
): Promise<CodexPromptExecution> {
  await ensureCodexAppServerRuntime(context.sandbox);
  const command = buildCodexPromptAppServerCommand({
    phase: options.phase,
    cwd: options.cwd,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    timeoutMs: options.timeoutMs,
    timeoutSeconds: options.timeoutSeconds,
    promptPath: '/workspace/prompt.txt',
    outputLastMessagePath: '/workspace/prompt-last-message.txt',
    outputSchemaPath: options.outputSchemaPath
  });

  const result = await emitCommandLifecycle(
    context.repoBoard,
    context.runId,
    options.phase,
    redactSensitiveText(command),
    () => context.sandbox.exec(command)
  );

  return {
    result,
    handledByFallback: shouldFallbackToLegacyCodexCli(result)
  };
}

async function emitCommandLifecycle(
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard'],
  runId: string,
  phase: Exclude<RunCommandPhase, 'operator'>,
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
    command: redactSensitiveText(command),
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
    stdoutPreview: summarizeOutput(result.stdout ? redactSensitiveText(result.stdout) : result.stdout),
    stderrPreview: summarizeOutput(result.stderr ? redactSensitiveText(result.stderr) : result.stderr)
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

function buildCodexPromptAppServerCommand(options: {
  phase: NonNullable<Parameters<LlmAdapter['runPrompt']>[1]['phase']>;
  cwd: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs: number;
  timeoutSeconds: number;
  promptPath: string;
  outputLastMessagePath: string;
  outputSchemaPath?: string;
}) {
  const commandConfig: CodexAppServerCommandConfig = {
    mode: 'prompt',
    cwd: options.cwd,
    model: options.model,
    reasoningEffort: options.reasoningEffort ?? 'medium',
    promptPath: options.promptPath,
    outputLastMessagePath: options.outputLastMessagePath,
    outputSchemaPath: options.outputSchemaPath,
    timeoutMs: options.timeoutMs
  };

  return `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
mkdir -p ${options.cwd}
cd ${options.cwd}
rm -f ${options.outputLastMessagePath}
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout ${options.timeoutSeconds}s "$@"
  else
    "$@"
  fi
}
run_with_timeout node ${CODEX_APPSERVER_RUNNER_PATH} ${shellQuote(JSON.stringify(commandConfig))}
if [ -f ${options.outputLastMessagePath} ]; then
  printf '\n===CODEX_LAST_MESSAGE===\n'
  cat ${options.outputLastMessagePath}
fi
`)}`;
}

async function runCodexAppServer(
  context: Parameters<LlmAdapter['run']>[0],
  options: {
    mode: CodexAppServerMode;
    cwd: string;
    model: string;
    reasoningEffort?: string;
    promptPath: string;
    outputSchemaPath?: string;
  }
): Promise<ManagedExecResult> {
  await ensureCodexAppServerRuntime(context.sandbox);
  const command = buildCodexAppServerRunCommand({
    mode: options.mode,
    cwd: options.cwd,
    model: options.model,
    reasoningEffort: options.reasoningEffort ?? 'medium',
    promptPath: options.promptPath,
    outputSchemaPath: options.outputSchemaPath
  });

  return runCodexProcessWithLogs(context, command);
}

function buildCodexAppServerRunCommand(options: {
  mode: CodexAppServerMode;
  cwd: string;
  model: string;
  reasoningEffort: string;
  promptPath: string;
  outputSchemaPath?: string;
}) {
  return `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
cd ${options.cwd}
node ${CODEX_APPSERVER_RUNNER_PATH} ${shellQuote(JSON.stringify(options))}
`)}`;
}

async function ensureCodexAppServerRuntime(sandbox: Parameters<LlmAdapter['run']>[0]['sandbox']) {
  await sandbox.writeFile(CODEX_APPSERVER_RUNNER_PATH, CODEX_APPSERVER_RUNNER);
}

function shouldFallbackToLegacyCodexCli(result: ManagedExecResult) {
  const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
  return !result.success && output.includes(CODEX_APPSERVER_UNAVAILABLE_MARKER);
}

function buildPromptResultFromExecResult(params: {
  result: { success: boolean; exitCode: number; stdout?: string; stderr?: string };
  startedAt: number;
  timeoutMs: number;
}) {
  const elapsedMs = Date.now() - params.startedAt;
  const rawOutput = params.result.stdout?.includes(CODEX_APPSERVER_LAST_MESSAGE_MARKER)
    ? params.result.stdout.split(CODEX_APPSERVER_LAST_MESSAGE_MARKER).slice(1).join(CODEX_APPSERVER_LAST_MESSAGE_MARKER).trim()
    : undefined;

  if (params.result.exitCode === 124) {
    return {
      status: 'timed_out',
      elapsedMs,
      timeoutMs: params.timeoutMs,
      rawOutput,
      stderr: params.result.stderr
    } as const;
  }

  if (!params.result.success) {
    return {
      status: 'failed',
      elapsedMs,
      message: params.result.stderr?.trim() || 'Codex prompt execution failed.',
      rawOutput,
      stderr: params.result.stderr
    } as const;
  }

  return {
    status: 'success',
    elapsedMs,
    rawOutput: rawOutput ?? '',
    stderr: params.result.stderr
  } as const;
}

async function runCodexProcessWithLogs(context: Parameters<LlmAdapter['run']>[0], command: string): Promise<ManagedExecResult> {
  const { sandbox, repoBoard, runId } = context;
  const phase: RunCommandPhase = 'codex';
  const commandId = buildRunCommandId(runId, phase);
  const run = await repoBoard.getRun(runId);
  const startedAt = new Date().toISOString();
  const stdoutBuffer = new LineLogBuffer();
  const stderrBuffer = new LineLogBuffer();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let completedAt = Date.now();
  let exitCode = 1;
  let streamError: string | undefined;
  let appendQueue = Promise.resolve();
  let latestResumeCommand: string | undefined;
  let latestThreadId: string | undefined;
  let lastStreamEventAt = Date.now();

  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase,
    startedAt,
    status: 'running',
    command: redactSensitiveText(command),
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
        logs.map((log) => buildRunLog(runId, redactSensitiveText(log.message), phase, log.level))
      )
    );
  };

  const process = await sandbox.startProcess(command);
  await repoBoard.transitionRun(runId, { codexProcessId: process.id });
  const stream = await sandbox.streamProcessLogs(process.id);
  const parseSSEStream = await getParseSSEStream();
  const iterator = parseSSEStream<Record<string, unknown>>(stream)[Symbol.asyncIterator]();

  try {
    while (true) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<Record<string, unknown>>>((_, reject) =>
          setTimeout(() => reject(new Error('CODEX_STREAM_IDLE_TIMEOUT')), CODEX_STREAM_INACTIVITY_TIMEOUT_MS)
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
          const sessionState = extractSessionState(chunk, latestThreadId);
          latestThreadId = sessionState.sessionId ?? latestThreadId;
          if (sessionState.resumeCommand && sessionState.resumeCommand !== latestResumeCommand) {
            latestResumeCommand = sessionState.resumeCommand;
            const latestRun = await repoBoard.getRun(runId);
            await repoBoard.transitionRun(runId, {
              llmAdapter: codexLlmAdapter.kind,
              llmSupportsResume: codexLlmAdapter.capabilities.supportsResume,
              llmResumeCommand: latestResumeCommand,
              llmSessionId: latestThreadId,
              latestCodexResumeCommand: latestResumeCommand
            });
            if (latestRun.operatorSession) {
              await repoBoard.updateOperatorSession(runId, {
                ...latestRun.operatorSession,
                llmAdapter: latestRun.operatorSession.llmAdapter ?? latestRun.llmAdapter ?? 'codex',
                llmSupportsResume: latestRun.operatorSession.llmSupportsResume ?? latestRun.llmSupportsResume ?? codexLlmAdapter.capabilities.supportsResume,
                llmResumeCommand: latestResumeCommand,
                llmSessionId: latestThreadId,
                codexResumeCommand: latestResumeCommand,
                codexThreadId: latestThreadId,
                takeoverState: latestRun.operatorSession.takeoverState === 'operator_control' ? 'resumable' : latestRun.operatorSession.takeoverState
              });
            }
            await repoBoard.appendRunEvents(runId, [
              buildRunEvent(
                await repoBoard.getRun(runId),
                'system',
                'codex.resume_available',
                `${codexLlmAdapter.capabilities.resumeCommandLabel ?? 'Resume command'} is available for this run.`,
                { command: latestResumeCommand }
              )
            ]);
          }
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
          completedAt = Date.now();
          exitCode = typeof event.exitCode === 'number' ? event.exitCode : exitCode;
          break;
        case 'error':
          completedAt = Date.now();
          streamError = typeof event.error === 'string' ? event.error : 'Command stream failed.';
          break;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CODEX_STREAM_IDLE_TIMEOUT') {
      const idleMs = Date.now() - lastStreamEventAt;
      streamError = `Codex stream inactivity timeout after ${Math.floor(idleMs / 1000)}s without events.`;
      try {
        await sandbox.killProcess(process.id);
      } catch {
        // best effort
      }
      await repoBoard.appendRunLogs(runId, [
        buildRunLog(runId, redactSensitiveText(`${streamError} Killed Codex process and failing run for retry.`), phase, 'error')
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

  await repoBoard.transitionRun(runId, { codexProcessId: undefined });
  await repoBoard.upsertRunCommands(runId, [{
    id: commandId,
    runId,
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode,
    status: success || stoppedForTakeover ? 'completed' : 'failed',
    command: redactSensitiveText(command),
    source: 'system',
    stdoutPreview: summarizeOutput(redactSensitiveText(stdout)),
    stderrPreview: summarizeOutput(redactSensitiveText(stderr))
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
    exitCode,
    stoppedForTakeover
  };
}

async function logCodexAuthDiagnostics(
  sandbox: Parameters<LlmAdapter['run']>[0]['sandbox'],
  runId: string,
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard']
) {
  await sandbox.writeFile(
    '/workspace/codex-auth-diagnostics.mjs',
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
console.log(\`HOME=\${home}\`);
const codexDir = path.join(home, '.codex');
if (!fs.existsSync(codexDir) || !fs.statSync(codexDir).isDirectory()) {
  console.log('Codex dir: missing');
  process.exit(0);
}

console.log('Codex dir: present');
for (const entry of fs.readdirSync(codexDir).sort()) {
  const fullPath = path.join(codexDir, entry);
  if (fs.statSync(fullPath).isFile()) {
    console.log(fullPath);
  }
}

const authPath = path.join(codexDir, 'auth.json');
if (!fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
  console.log('Codex auth file: missing');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
console.log(\`Codex auth file: \${authPath}\`);
const configPath = path.join(codexDir, 'config.toml');
console.log(\`Codex config file: \${configPath}\`);
if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
  const config = fs.readFileSync(configPath, 'utf8');
  console.log(\`Cloudflare MCP configured: \${config.includes('[mcp_servers.cloudflare-doc-mcp]') ? 'yes' : 'no'}\`);
} else {
  console.log('Cloudflare MCP configured: no');
}
const apiKey = typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY ? data.OPENAI_API_KEY : null;
console.log(\`Codex OPENAI_API_KEY present: \${apiKey ? 'yes' : 'no'}\`);
const runtimeApiKey = typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY : null;
console.log(\`Runtime OPENAI_API_KEY present: \${runtimeApiKey ? 'yes' : 'no'}\`);
const accessToken = data.tokens && typeof data.tokens.access_token === 'string' && data.tokens.access_token
  ? data.tokens.access_token
  : null;
console.log(\`Codex access_token present: \${accessToken ? 'yes' : 'no'}\`);
`
  );
  const diagnostics = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
node /workspace/codex-auth-diagnostics.mjs
`)}`
  );
  await appendCommandLogs(repoBoard, runId, 'bootstrap', diagnostics.stdout, diagnostics.stderr);
  if (!diagnostics.success) {
    throw await createNonRetryableError('Codex auth diagnostics failed.');
  }
  const stdout = diagnostics.stdout ?? '';
  if (stdout.includes('Codex dir: missing')) {
    throw await createNonRetryableError('Codex auth directory is missing after restore.');
  }
  if (stdout.includes('Codex auth file: missing')) {
    throw await createNonRetryableError('Codex auth file is missing after restore.');
  }
  if (stdout.includes('Cloudflare MCP configured: no')) {
    throw await createNonRetryableError('Cloudflare MCP is not configured in sandbox codex config.');
  }
  if (
    stdout.includes('Codex OPENAI_API_KEY present: no')
    && stdout.includes('Runtime OPENAI_API_KEY present: no')
    && stdout.includes('Codex access_token present: no')
  ) {
    throw await createNonRetryableError('Codex auth file is present but contains no usable credentials.');
  }
}

async function readCodexRateLimits(
  sandbox: Parameters<LlmAdapter['run']>[0]['sandbox'],
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard'],
  runId: string
): Promise<CodexRateLimitsResponse | undefined> {
  await sandbox.writeFile(
    '/workspace/codex-rate-limits.mjs',
    `import { spawn } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const child = spawn('codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdoutBuffer = '';
let stderrBuffer = '';
let resolved = false;

const timeout = setTimeout(() => {
  if (!resolved) {
    child.kill('SIGTERM');
    fail('Timed out while reading Codex rate limits.');
  }
}, 10000);

child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf('\\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' }) + '\\n');
      continue;
    }
    if (message.id === 2) {
      resolved = true;
      clearTimeout(timeout);
      console.log(JSON.stringify(message.result));
      child.kill('SIGTERM');
      return;
    }
  }
});

child.on('exit', (code) => {
  if (resolved) {
    return;
  }
  clearTimeout(timeout);
  fail(stderrBuffer.trim() || \`Codex app-server exited before returning rate limits (code \${code ?? 'unknown'}).\`);
});

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    apiVersion: 2,
    clientInfo: { name: 'agentboard-rate-limit-probe', version: '1.0.0' }
  }
}) + '\\n');
`
  );
  const result = await sandbox.exec(
    `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
node /workspace/codex-rate-limits.mjs
`)}`
  );
  if (!result.success) {
    await appendCommandLogs(repoBoard, runId, 'codex', result.stdout, result.stderr);
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(runId, 'Codex usage preflight failed. Continuing without a rate-limit wait.', 'codex', 'error')
    ]);
    return undefined;
  }

  try {
    return JSON.parse(result.stdout.trim()) as CodexRateLimitsResponse;
  } catch (error) {
    await repoBoard.appendRunLogs(runId, [
      buildRunLog(
        runId,
        `Codex usage preflight returned invalid JSON (${error instanceof Error ? error.message : String(error)}). Continuing without a rate-limit wait.`,
        'codex',
        'error'
      )
    ]);
    return undefined;
  }
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

function summarizeOutput(output?: string) {
  if (!output?.trim()) {
    return undefined;
  }

  const compact = output.trim().replace(/\s+/g, ' ');
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

async function appendCommandLogs(
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard'],
  runId: string,
  phase: NonNullable<ReturnType<typeof buildRunLog>['phase']>,
  stdout?: string,
  stderr?: string
) {
  const logs = [];
  if (stdout?.trim()) logs.push(buildRunLog(runId, redactSensitiveText(stdout.trim()), phase));
  if (stderr?.trim()) logs.push(buildRunLog(runId, redactSensitiveText(stderr.trim()), phase, 'error'));
  if (logs.length) await repoBoard.appendRunLogs(runId, logs);
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

function extractSessionState(chunk: string, fallbackSessionId?: string) {
  const sessionMatch = chunk.match(/"thread_id":"([^"]+)"/);
  const sessionId = sessionMatch?.[1] ?? fallbackSessionId;
  const resumeMatch = chunk.match(/codex resume ([a-z0-9-]+)/i);
  const resumeCommand = resumeMatch?.[1] ? `codex resume ${resumeMatch[1]}` : undefined;
  return { sessionId, resumeCommand };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function getParseSSEStream() {
  if (parseSSEStreamFn) {
    return parseSSEStreamFn;
  }
  const sandbox = await import('@cloudflare/sandbox');
  parseSSEStreamFn = sandbox.parseSSEStream as <T>(stream: unknown) => AsyncIterable<T>;
  return parseSSEStreamFn;
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
