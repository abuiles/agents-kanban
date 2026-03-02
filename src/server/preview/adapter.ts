import type { LlmExecutionRequest } from '../llm/adapter';
import type { Repo, Task, AgentRun, PreviewAdapterKind, LlmReasoningEffort } from '../../ui/domain/types';
import type { ScmCommitCheck } from '../scm/adapter';

export type PreviewDiscoverySource = 'summary' | 'details_url' | 'html_url';

export type PreviewDiagnostic = {
  code: string;
  level: 'info' | 'error';
  message: string;
  metadata?: Record<string, string | number | boolean>;
};

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
  status: 'ready' | 'pending' | 'failed' | 'timed_out';
  previewUrl?: string;
  adapter: PreviewAdapterKind;
  explanation: string;
  diagnostics: PreviewDiagnostic[];
};

export type PreviewAdapterContext = {
  repo: Repo;
  task?: Task;
  run?: AgentRun;
  checks: ScmCommitCheck[];
  promptRecipeRuntime?: {
    cwd: string;
    model: string;
    reasoningEffort?: LlmReasoningEffort;
    execute(request: LlmExecutionRequest, timeoutMs: number): Promise<PreviewPromptRecipeRuntimeResult>;
  };
};

export type PreviewPromptRecipeRuntimeResult =
  | {
      status: 'success';
      elapsedMs: number;
      rawOutput: string;
    }
  | {
      status: 'failed';
      elapsedMs: number;
      message: string;
      rawOutput?: string;
    }
  | {
      status: 'timed_out';
      elapsedMs: number;
      timeoutMs: number;
      rawOutput?: string;
    };

export type PreviewAdapterResult = {
  resolution: PreviewResolution;
  compatibility: PreviewDiscoveryResult;
};

export type PreviewAdapter = {
  kind: PreviewAdapterKind;
  resolve(context: PreviewAdapterContext): Promise<PreviewAdapterResult>;
};
