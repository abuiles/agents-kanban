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
    if (!env.OPENAI_API_KEY?.trim()) {
      throw new Error('Repo is configured with llmAuthMode=api but OPENAI_API_KEY is missing.');
    }
    await context.repoBoard.appendRunLogs(context.runId, [
      buildRunLog(context.runId, 'Skipping Codex auth bundle restore (api mode).', request.phase ?? 'codex')
    ]);
  } else {
    await adapter.restoreAuth({ ...context, repo: request.repo });
  }
  await adapter.logDiagnostics(context, request);
  await adapter.waitForCapacityIfNeeded?.(context, request, sleepFn);
  return adapter.runPrompt(context, request);
}
