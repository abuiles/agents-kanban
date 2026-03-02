import type {
  Repo,
  Task,
  AgentRun,
  LlmReasoningEffort,
  PreviewAdapterKind,
  PreviewDiagnostic,
  PreviewResolutionStatus
} from '../../ui/domain/types';
import type { ScmCommitCheck } from '../scm/adapter';
import type { LlmAdapter, LlmPromptExecutionResult, LlmRuntimeContext, SleepFn } from '../llm/adapter';

export type PreviewDiscoverySource = 'summary' | 'details_url' | 'html_url';

export type PreviewDiscoveryResult = {
  previewUrl?: string;
  adapter?: string;
  source?: PreviewDiscoverySource;
  matchedCheck?: string;
  checks: Array<{
    name?: string;
    appSlug?: string;
    rawSource?: ScmCommitCheck['rawSource'];
    status?: ScmCommitCheck['status'];
    conclusion?: ScmCommitCheck['conclusion'];
    score: number;
    matchedAdapter?: string;
    extracted: boolean;
  }>;
};

export type PreviewResolution = {
  status: PreviewResolutionStatus;
  previewUrl?: string;
  adapter: PreviewAdapterKind;
  explanation: string;
  diagnostics: PreviewDiagnostic[];
};

export type PreviewLlmContext = {
  adapter: LlmAdapter;
  runtimeContext: LlmRuntimeContext;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  cwd: string;
  sleepFn: SleepFn;
  runPrompt: (prompt: string, options?: { timeoutMs?: number; outputSchema?: Record<string, unknown> }) => Promise<LlmPromptExecutionResult>;
};

export type PreviewAdapterContext = {
  repo: Repo;
  task?: Task;
  run?: AgentRun;
  checks: ScmCommitCheck[];
  llm?: PreviewLlmContext;
};

export type PreviewAdapterResult = {
  resolution: PreviewResolution;
  compatibility: PreviewDiscoveryResult;
};

export type PreviewAdapter = {
  kind: PreviewAdapterKind;
  resolve(context: PreviewAdapterContext): PreviewAdapterResult | Promise<PreviewAdapterResult>;
};
