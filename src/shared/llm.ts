import type { AutoReviewMode, AgentRun, CodexModel, CodexReasoningEffort, LlmAdapter, LlmReasoningEffort, OperatorSession, TaskUiMeta } from '../ui/domain/types';

export const DEFAULT_LLM_ADAPTER: LlmAdapter = 'codex';
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-5.1-codex-mini';
export const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'medium';
export const DEFAULT_AUTO_REVIEW_MODE: AutoReviewMode = 'inherit';
export const DEFAULT_SUPPORTS_RESUME_BY_ADAPTER: Record<LlmAdapter, boolean> = {
  codex: true,
  cursor_cli: false,
  claude_code: false
};

export function normalizeTaskUiMeta(uiMeta?: TaskUiMeta): TaskUiMeta | undefined {
  if (!uiMeta) {
    return undefined;
  }

  const llmAdapter = uiMeta.llmAdapter ?? DEFAULT_LLM_ADAPTER;
  const llmModel = uiMeta.llmModel ?? uiMeta.codexModel ?? (llmAdapter === 'codex' ? DEFAULT_CODEX_MODEL : undefined);
  const llmReasoningEffort = uiMeta.llmReasoningEffort
    ?? uiMeta.codexReasoningEffort
    ?? (llmAdapter === 'codex' ? DEFAULT_REASONING_EFFORT : undefined);
  const autoReviewMode = uiMeta.autoReviewMode ?? DEFAULT_AUTO_REVIEW_MODE;

  return {
    ...uiMeta,
    llmAdapter,
    llmModel,
    llmReasoningEffort,
    autoReviewMode,
    codexModel: llmAdapter === 'codex' ? (uiMeta.codexModel ?? llmModel as CodexModel | undefined) : uiMeta.codexModel,
    codexReasoningEffort: llmAdapter === 'codex'
      ? (uiMeta.codexReasoningEffort ?? llmReasoningEffort as CodexReasoningEffort | undefined)
      : uiMeta.codexReasoningEffort
  };
}

export function normalizeOperatorSession(session?: OperatorSession): OperatorSession | undefined {
  if (!session) {
    return undefined;
  }

  const llmAdapter = session.llmAdapter ?? DEFAULT_LLM_ADAPTER;
  const llmSupportsResume = session.llmSupportsResume ?? DEFAULT_SUPPORTS_RESUME_BY_ADAPTER[llmAdapter];
  const llmSessionId = session.llmSessionId ?? session.codexThreadId;
  const llmResumeCommand = session.llmResumeCommand ?? session.codexResumeCommand;

  return {
    ...session,
    llmAdapter,
    llmSupportsResume,
    llmSessionId,
    llmResumeCommand,
    codexThreadId: llmAdapter === 'codex' ? (session.codexThreadId ?? llmSessionId) : session.codexThreadId,
    codexResumeCommand: llmAdapter === 'codex' ? (session.codexResumeCommand ?? llmResumeCommand) : session.codexResumeCommand
  };
}

export function normalizeRunLlmState(run: AgentRun): AgentRun {
  const operatorSession = normalizeOperatorSession(run.operatorSession);
  const llmAdapter = run.llmAdapter ?? operatorSession?.llmAdapter ?? DEFAULT_LLM_ADAPTER;
  const llmSupportsResume = run.llmSupportsResume
    ?? operatorSession?.llmSupportsResume
    ?? DEFAULT_SUPPORTS_RESUME_BY_ADAPTER[llmAdapter];
  const llmResumeCommand = run.llmResumeCommand
    ?? run.latestCodexResumeCommand
    ?? operatorSession?.llmResumeCommand
    ?? operatorSession?.codexResumeCommand;
  const llmSessionId = run.llmSessionId ?? operatorSession?.llmSessionId ?? operatorSession?.codexThreadId;

  return {
    ...run,
    operatorSession,
    llmAdapter,
    llmSupportsResume,
    llmResumeCommand,
    llmSessionId,
    latestCodexResumeCommand: llmAdapter === 'codex' ? (run.latestCodexResumeCommand ?? llmResumeCommand) : run.latestCodexResumeCommand,
    llmModel: run.llmModel,
    llmReasoningEffort: run.llmReasoningEffort as LlmReasoningEffort | undefined
  };
}
