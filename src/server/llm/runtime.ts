import type { LlmAdapter, LlmPromptExecutionRequest, LlmPromptExecutionResult, LlmRuntimeContext, SleepFn } from './adapter';
import { buildRunLog } from '../shared/real-run';
import { restoreAgentsHomeBundle } from './home-bundle';

const LLM_RESPONSE_LOG_CHUNK_SIZE = 900;

function chunkText(value: string, size = LLM_RESPONSE_LOG_CHUNK_SIZE) {
  if (size <= 0) {
    return [value];
  }

  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length ? chunks : [''];
}

export async function executePromptWithLlmAdapter(
  adapter: LlmAdapter,
  context: LlmRuntimeContext,
  request: LlmPromptExecutionRequest,
  sleepFn: SleepFn
): Promise<LlmPromptExecutionResult> {
  await adapter.ensureInstalled(context);
  await restoreAgentsHomeBundle(context, request.repo, request.phase ?? 'codex');
  const authMode = request.repo.llmAuthMode === 'api' ? 'api' : 'bundle';
  await context.repoBoard.appendRunLogs(context.runId, [
    buildRunLog(context.runId, `LLM auth mode: ${authMode}.`, request.phase ?? 'codex')
  ]);
  if (adapter.kind === 'codex' && authMode === 'api') {
    const env = context.env as Env & { OPENAI_API_KEY?: string };
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('Repo is configured with llmAuthMode=api but OPENAI_API_KEY is missing.');
    }
    await context.sandbox.writeFile(
      '/workspace/codex-auth-api.json',
      JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)
    );
    await context.sandbox.exec(
      `bash -lc 'set -euo pipefail
export HOME="/root"
mkdir -p "$HOME/.codex"
cp /workspace/codex-auth-api.json "$HOME/.codex/auth.json"
rm -f "$HOME/.codex/._auth.json"
'`
    );
    await context.repoBoard.appendRunLogs(context.runId, [
      buildRunLog(context.runId, 'Skipping Codex auth bundle restore (api mode) and forcing API-key auth.', request.phase ?? 'codex')
    ]);
  } else {
    await adapter.restoreAuth({ ...context, repo: request.repo });
  }
  await adapter.logDiagnostics(context, request);
  await adapter.waitForCapacityIfNeeded?.(context, request, sleepFn);
  const result = await adapter.runPrompt(context, request);
  const phase = request.phase ?? 'codex';
  const logs: Array<ReturnType<typeof buildRunLog>> = [];

  if (typeof result.rawOutput === 'string') {
    const rawOutput = result.rawOutput;
    const chunks = chunkText(rawOutput);
    const baseMetadata: Record<string, string | number | boolean> = {
      adapter: adapter.kind,
      model: request.model,
      status: result.status,
      phase,
      elapsedMs: result.elapsedMs,
      chunkCount: chunks.length,
      outputLength: rawOutput.length
    };

    logs.push(
      ...chunks.map((chunk, index) =>
        buildRunLog(
          context.runId,
          `LLM ${phase} prompt response (raw): ${chunk || '<empty>'}`,
          phase,
          'info',
          {
            ...baseMetadata,
            chunkIndex: index + 1,
            ...(result.status === 'timed_out' ? { timeoutMs: result.timeoutMs } : {})
          }
        )
      )
    );
  }

  if (result.status === 'timed_out') {
    logs.push(
      buildRunLog(
        context.runId,
        `LLM ${phase} prompt timed out after ${result.timeoutMs}ms.`,
        phase,
        'error',
        {
          adapter: adapter.kind,
          model: request.model,
          status: 'timed_out',
          phase,
          elapsedMs: result.elapsedMs,
          timeoutMs: result.timeoutMs
        }
      )
    );
  }

  if (result.status === 'failed') {
    logs.push(
      buildRunLog(
        context.runId,
        `LLM ${phase} prompt failed: ${result.message}`,
        phase,
        'error',
        {
          adapter: adapter.kind,
          model: request.model,
          status: result.status,
          phase,
          elapsedMs: result.elapsedMs
        }
      )
    );
  }

  if (result.stderr?.trim()) {
    logs.push(
      buildRunLog(context.runId, `LLM ${phase} prompt stderr: ${result.stderr}`, phase, 'error', {
        adapter: adapter.kind,
        model: request.model,
        status: result.status,
        phase,
        elapsedMs: result.elapsedMs
      })
    );
  }

  if (logs.length) {
    await context.repoBoard.appendRunLogs(context.runId, logs);
  }
  return result;
}
