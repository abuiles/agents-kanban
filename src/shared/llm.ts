import type { AgentRun, CodexModel, LlmAdapterKind, LlmReasoningEffort, OperatorSession, Task, TaskUiMeta } from '../ui/domain/types';

export const LLM_ADAPTERS = new Set(['codex', 'cursor_cli'] as const);
export const LLM_REASONING_EFFORTS = new Set(['low', 'medium', 'high'] as const);
export const CODEX_MODELS = new Set(['gpt-5.1-codex-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'] as const);

export const DEFAULT_LLM_ADAPTER: LlmAdapterKind = 'codex';
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-5.1-codex-mini';
export const DEFAULT_LLM_REASONING_EFFORT: LlmReasoningEffort = 'medium';

function resolveAdapter(input?: { llmAdapter?: LlmAdapterKind; codexModel?: string; codexReasoningEffort?: string; llmModel?: string; llmReasoningEffort?: string }): LlmAdapterKind | undefined {
  if (input?.llmAdapter) {
    return input.llmAdapter;
  }

  if (input?.codexModel || input?.codexReasoningEffort) {
    return 'codex';
  }

  if (input?.llmModel || input?.llmReasoningEffort) {
    return DEFAULT_LLM_ADAPTER;
  }

  return undefined;
}

export function buildTaskUiMeta(input?: Partial<TaskUiMeta>): TaskUiMeta {
  const adapter = resolveAdapter(input) ?? DEFAULT_LLM_ADAPTER;
  const llmModel = input?.llmModel ?? input?.codexModel ?? DEFAULT_CODEX_MODEL;
  const llmReasoningEffort = input?.llmReasoningEffort ?? input?.codexReasoningEffort ?? DEFAULT_LLM_REASONING_EFFORT;

  return {
    simulationProfile: input?.simulationProfile ?? 'happy_path',
    llmAdapter: adapter,
    llmModel,
    llmReasoningEffort,
    codexModel: adapter === 'codex' ? (llmModel as CodexModel) : undefined,
    codexReasoningEffort: adapter === 'codex' ? llmReasoningEffort : undefined
  };
}

export function normalizeTask(task: Task): Task {
  return {
    ...task,
    uiMeta: task.uiMeta ? buildTaskUiMeta(task.uiMeta) : undefined
  };
}

export function getTaskLlmConfig(task: Pick<Task, 'uiMeta'> | { uiMeta?: TaskUiMeta | undefined }) {
  const uiMeta = buildTaskUiMeta(task.uiMeta);
  return {
    llmAdapter: uiMeta.llmAdapter ?? DEFAULT_LLM_ADAPTER,
    llmModel: uiMeta.llmModel ?? DEFAULT_CODEX_MODEL,
    llmReasoningEffort: uiMeta.llmReasoningEffort ?? DEFAULT_LLM_REASONING_EFFORT,
    codexModel: uiMeta.codexModel ?? DEFAULT_CODEX_MODEL,
    codexReasoningEffort: uiMeta.codexReasoningEffort ?? DEFAULT_LLM_REASONING_EFFORT
  };
}

export function normalizeOperatorSession(session?: OperatorSession, defaults?: Partial<Pick<AgentRun, 'llmAdapter' | 'llmSessionId' | 'llmResumeCommand' | 'latestCodexResumeCommand'>>): OperatorSession | undefined {
  if (!session) {
    return undefined;
  }

  const llmAdapter = session.llmAdapter ?? defaults?.llmAdapter ?? (session.codexThreadId || session.codexResumeCommand || defaults?.latestCodexResumeCommand ? 'codex' : undefined);
  const llmSessionId = session.llmSessionId ?? session.codexThreadId ?? defaults?.llmSessionId;
  const llmResumeCommand = session.llmResumeCommand ?? session.codexResumeCommand ?? defaults?.llmResumeCommand ?? defaults?.latestCodexResumeCommand;

  return {
    ...session,
    llmAdapter,
    llmSessionId,
    llmResumeCommand,
    codexThreadId: llmAdapter === 'codex' ? llmSessionId : undefined,
    codexResumeCommand: llmAdapter === 'codex' ? llmResumeCommand : undefined
  };
}

export function normalizeRun(run: AgentRun): AgentRun {
  const taskLlm = run.llmAdapter || run.llmModel || run.llmReasoningEffort
    ? {
        llmAdapter: run.llmAdapter,
        llmModel: run.llmModel,
        llmReasoningEffort: run.llmReasoningEffort
      }
    : undefined;
  const fallbackAdapter = run.operatorSession?.llmAdapter ?? (run.operatorSession?.codexThreadId ? 'codex' : undefined);
  const adapter = resolveAdapter({
    llmAdapter: taskLlm?.llmAdapter,
    llmModel: taskLlm?.llmModel,
    llmReasoningEffort: taskLlm?.llmReasoningEffort,
    codexModel: run.latestCodexResumeCommand,
    codexReasoningEffort: undefined
  }) ?? fallbackAdapter ?? (run.latestCodexResumeCommand ? 'codex' : undefined);
  const llmResumeCommand = run.llmResumeCommand ?? run.latestCodexResumeCommand ?? run.operatorSession?.llmResumeCommand ?? run.operatorSession?.codexResumeCommand;
  const llmSessionId = run.llmSessionId ?? run.operatorSession?.llmSessionId ?? run.operatorSession?.codexThreadId;

  return {
    ...run,
    llmAdapter: taskLlm?.llmAdapter ?? run.llmAdapter ?? run.operatorSession?.llmAdapter ?? (llmResumeCommand || llmSessionId ? 'codex' : undefined),
    llmModel: run.llmModel,
    llmReasoningEffort: run.llmReasoningEffort,
    llmResumeCommand,
    llmSessionId,
    latestCodexResumeCommand: (adapter ?? run.llmAdapter) === 'codex' ? llmResumeCommand : undefined,
    operatorSession: normalizeOperatorSession(run.operatorSession, {
      llmAdapter: run.llmAdapter ?? adapter,
      llmSessionId,
      llmResumeCommand,
      latestCodexResumeCommand: run.latestCodexResumeCommand
    })
  };
}

export function buildRunLlmState(task: Pick<Task, 'uiMeta'>) {
  const config = getTaskLlmConfig(task);
  return {
    llmAdapter: config.llmAdapter,
    llmModel: config.llmModel,
    llmReasoningEffort: config.llmReasoningEffort
  };
}
