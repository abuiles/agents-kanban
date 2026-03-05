import type { LlmAdapter, LlmPromptExecutionRequest } from './adapter';
import { buildRunLog } from '../shared/real-run';
import { redactSensitiveText } from '../security/redaction';

export const claudeCodeLlmAdapter: LlmAdapter = {
  kind: 'claude_code',
  capabilities: {
    supportsResume: false,
    supportsTakeover: true
  },

  async ensureInstalled(context) {
    const result = await context.sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
if command -v claude >/dev/null 2>&1; then
  exit 0
fi
if command -v npm >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
fi
command -v claude >/dev/null 2>&1
`)}`
    );
    await appendCommandLogs(context.repoBoard, context.runId, 'bootstrap', result.stdout, result.stderr);
    if (!result.success) {
      throw await createNonRetryableError('Claude Code CLI is not available in the sandbox.');
    }
  },

  async restoreAuth() {
    // Anthropic auth comes from runtime env export (ANTHROPIC_API_KEY).
  },

  async logDiagnostics(context, request) {
    const diagnostics = await context.sandbox.exec(
      `bash -lc ${shellQuote(`set -euo pipefail
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI is not installed." >&2
  exit 127
fi
claude --version
printf 'Claude model: ${request.model}\\n'
printf 'Claude reasoning effort: ${request.reasoningEffort ?? 'medium'}\\n'
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
  echo "Claude ANTHROPIC_API_KEY present: yes"
else
  echo "Claude ANTHROPIC_API_KEY present: no"
fi
`)}`
    );
    await appendCommandLogs(context.repoBoard, context.runId, 'bootstrap', diagnostics.stdout, diagnostics.stderr);
    if (!diagnostics.success) {
      throw await createNonRetryableError('Claude diagnostics failed because the CLI is unavailable.');
    }
    if ((diagnostics.stdout ?? '').includes('Claude ANTHROPIC_API_KEY present: no')) {
      throw await createNonRetryableError('Missing ANTHROPIC_API_KEY runtime secret for Claude Code execution.');
    }
  },

  async run(context, request) {
    await context.sandbox.writeFile('/workspace/task.txt', request.prompt);
    const command = `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
cd ${request.cwd}
PROMPT="$(cat /workspace/task.txt)"
claude -p --model ${shellQuote(request.model)} "$PROMPT"
`)}`;
    const result = await context.sandbox.exec(command);
    await appendCommandLogs(context.repoBoard, context.runId, 'codex', result.stdout, result.stderr);
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr
    };
  },

  async runPrompt(context, request: LlmPromptExecutionRequest) {
    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? 45_000;
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    await context.sandbox.writeFile('/workspace/prompt.txt', request.prompt);
    const command = `bash -lc ${shellQuote(`set -euo pipefail
export HOME="\${HOME:-/root}"
if [ -f /workspace/agent-env.sh ]; then
  . /workspace/agent-env.sh
fi
mkdir -p ${request.cwd}
cd ${request.cwd}
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout ${timeoutSeconds}s "$@"
  else
    "$@"
  fi
}
PROMPT="$(cat /workspace/prompt.txt)"
run_with_timeout claude -p --model ${shellQuote(request.model)} "$PROMPT"
`)}`;
    const result = await context.sandbox.exec(command);
    const phase = request.phase ?? 'preview';
    await appendCommandLogs(context.repoBoard, context.runId, phase, result.stdout, result.stderr);
    const elapsedMs = Date.now() - startedAt;
    const rawOutput = result.stdout?.trim();

    if (result.exitCode === 124) {
      return {
        status: 'timed_out',
        elapsedMs,
        timeoutMs,
        rawOutput,
        stderr: result.stderr
      };
    }

    if (!result.success) {
      return {
        status: 'failed',
        elapsedMs,
        message: result.stderr?.trim() || 'Claude Code prompt execution failed.',
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

async function appendCommandLogs(
  repoBoard: Parameters<LlmAdapter['run']>[0]['repoBoard'],
  runId: string,
  phase: 'bootstrap' | 'codex' | 'tests' | 'push' | 'pr' | 'preview' | 'evidence',
  stdout?: string,
  stderr?: string
) {
  const logs = [
    ...(stdout ? stdout.split(/\r?\n/).filter(Boolean).map((line) => buildRunLog(runId, redactSensitiveText(line), phase, 'info')) : []),
    ...(stderr ? stderr.split(/\r?\n/).filter(Boolean).map((line) => buildRunLog(runId, redactSensitiveText(line), phase, 'error')) : [])
  ];
  if (logs.length) {
    await repoBoard.appendRunLogs(runId, logs);
  }
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
