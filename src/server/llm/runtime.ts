import type { LlmAdapter, LlmPromptExecutionRequest, LlmPromptExecutionResult, LlmRuntimeContext, SleepFn } from './adapter';

export async function executePromptWithLlmAdapter(
  adapter: LlmAdapter,
  context: LlmRuntimeContext,
  request: LlmPromptExecutionRequest,
  sleepFn: SleepFn
): Promise<LlmPromptExecutionResult> {
  await adapter.ensureInstalled(context);
  await adapter.restoreAuth({ ...context, repo: request.repo });
  await adapter.logDiagnostics(context, request);
  await adapter.waitForCapacityIfNeeded?.(context, request, sleepFn);
  return adapter.runPrompt(context, request);
}
