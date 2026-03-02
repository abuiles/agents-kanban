import type { LlmAdapter as LlmAdapterKind, Task } from '../../ui/domain/types';
import { DEFAULT_LLM_ADAPTER } from '../../shared/llm';
import type { LlmAdapter, LlmAdapterCapabilities } from './adapter';
import { codexLlmAdapter } from './codex';
import { cursorCliLlmAdapter } from './cursor-cli';

const LLM_ADAPTERS: Record<LlmAdapterKind, LlmAdapter> = {
  codex: codexLlmAdapter,
  cursor_cli: cursorCliLlmAdapter
};

export function resolveLlmAdapterKind(task: Pick<Task, 'uiMeta'>, runAdapter?: LlmAdapterKind): LlmAdapterKind {
  return runAdapter ?? task.uiMeta?.llmAdapter ?? DEFAULT_LLM_ADAPTER;
}

export function getLlmAdapter(kind: LlmAdapterKind): LlmAdapter {
  const adapter = LLM_ADAPTERS[kind];
  if (!adapter) {
    throw new Error(`LLM adapter ${kind} is not supported yet.`);
  }
  return adapter;
}

export function getLlmAdapterCapabilities(kind: LlmAdapterKind): LlmAdapterCapabilities {
  return getLlmAdapter(kind).capabilities;
}
