import type { getSandbox } from '@cloudflare/sandbox';
import type { RepoBoardDO } from '../durable/repo-board';
import type { AgentRun, LlmAdapter as LlmAdapterKind, LlmReasoningEffort, Repo, Task } from '../../ui/domain/types';

export type SandboxHandle = ReturnType<typeof getSandbox>;
export type RepoBoardHandle = DurableObjectStub<RepoBoardDO>;

export type SleepFn = (name: string, duration: number | `${number} ${string}`) => Promise<void>;

export type LlmExecutionRequest = {
  repo: Repo;
  task: Task;
  run: AgentRun;
  cwd: string;
  prompt: string;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
};

export type LlmExecutionResult = {
  success: boolean;
  stoppedForTakeover?: boolean;
  stderr?: string;
  resumeCommand?: string;
  sessionId?: string;
};

export type LlmSessionState = {
  sessionId?: string;
  resumeCommand?: string;
};

export type LlmAdapterCapabilities = {
  supportsResume: boolean;
  supportsTakeover: boolean;
  resumeCommandLabel?: string;
};

export type LlmRuntimeContext = {
  env: Env;
  sandbox: SandboxHandle;
  repoBoard: RepoBoardHandle;
  runId: string;
};

export type LlmAdapter = {
  kind: LlmAdapterKind;
  capabilities: LlmAdapterCapabilities;

  ensureInstalled(context: LlmRuntimeContext): Promise<void>;
  restoreAuth(context: LlmRuntimeContext & { repo: Repo }): Promise<void>;
  logDiagnostics(context: LlmRuntimeContext, request: LlmExecutionRequest): Promise<void>;
  waitForCapacityIfNeeded?(context: LlmRuntimeContext, request: LlmExecutionRequest, sleepFn: SleepFn): Promise<void>;
  run(context: LlmRuntimeContext, request: LlmExecutionRequest): Promise<LlmExecutionResult>;

  extractSessionState?(chunk: string, fallbackSessionId?: string): LlmSessionState;
};
