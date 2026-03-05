import type { LlmAdapter, LlmPromptExecutionRequest, LlmPromptExecutionResult, LlmRuntimeContext, SleepFn } from './adapter';
import { buildRunLog } from '../shared/real-run';

export async function executePromptWithLlmAdapter(
  adapter: LlmAdapter,
  context: LlmRuntimeContext,
  request: LlmPromptExecutionRequest,
  sleepFn: SleepFn
): Promise<LlmPromptExecutionResult> {
  await adapter.ensureInstalled(context);
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
  return adapter.runPrompt(context, request);
}
