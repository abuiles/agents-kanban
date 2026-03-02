import type { ArtifactManifest, AgentRun, Repo, RunError, RunLogEntry, RunStatus, Task } from '../../ui/domain/types';
import { DEFAULT_SUPPORTS_RESUME_BY_ADAPTER, normalizeRunLlmState, normalizeTaskUiMeta } from '../../shared/llm';
import { normalizeRunReviewMetadata } from '../../shared/scm';

export type RunJobMode = 'full_run' | 'evidence_only' | 'preview_only';

export type RunJobParams = {
  repoId: string;
  taskId: string;
  runId: string;
  mode: RunJobMode;
};

export type RunTransitionPatch = {
  status?: RunStatus;
  branchName?: string;
  headSha?: string;
  reviewUrl?: string;
  reviewNumber?: number;
  reviewProvider?: AgentRun['reviewProvider'];
  reviewState?: AgentRun['reviewState'];
  reviewMergedAt?: AgentRun['reviewMergedAt'];
  prUrl?: string;
  prNumber?: number;
  landedOnDefaultBranch?: AgentRun['landedOnDefaultBranch'];
  landedOnDefaultBranchAt?: AgentRun['landedOnDefaultBranchAt'];
  previewUrl?: string;
  previewStatus?: AgentRun['previewStatus'];
  evidenceStatus?: AgentRun['evidenceStatus'];
  workflowInstanceId?: string;
  orchestrationMode?: AgentRun['orchestrationMode'];
  sandboxId?: string;
  evidenceSandboxId?: string;
  commitSha?: string;
  commitMessage?: string;
  codexProcessId?: string;
  currentCommandId?: string;
  llmAdapter?: AgentRun['llmAdapter'];
  llmSupportsResume?: AgentRun['llmSupportsResume'];
  llmModel?: AgentRun['llmModel'];
  llmReasoningEffort?: AgentRun['llmReasoningEffort'];
  llmResumeCommand?: AgentRun['llmResumeCommand'];
  llmSessionId?: AgentRun['llmSessionId'];
  latestCodexResumeCommand?: string;
  operatorSession?: AgentRun['operatorSession'];
  artifactManifest?: ArtifactManifest;
  artifacts?: string[];
  executionSummary?: AgentRun['executionSummary'];
  endedAt?: string;
  currentStepStartedAt?: string;
  appendTimelineNote?: string;
};

type CreateRealRunOptions = {
  branchName?: string;
  reviewUrl?: string;
  reviewNumber?: number;
  reviewProvider?: AgentRun['reviewProvider'];
  reviewState?: AgentRun['reviewState'];
  reviewMergedAt?: AgentRun['reviewMergedAt'];
  prUrl?: string;
  prNumber?: number;
  landedOnDefaultBranch?: AgentRun['landedOnDefaultBranch'];
  landedOnDefaultBranchAt?: AgentRun['landedOnDefaultBranchAt'];
  baseRunId?: string;
  changeRequest?: AgentRun['changeRequest'];
  dependencyContext?: AgentRun['dependencyContext'];
};

export function createRealRun(task: Task, runId: string, now = new Date(), options?: CreateRealRunOptions): AgentRun {
  const nowIso = now.toISOString();
  const taskUiMeta = normalizeTaskUiMeta(task.uiMeta);
  const llmAdapter = taskUiMeta?.llmAdapter ?? 'codex';
  return normalizeRunLlmState(normalizeRunReviewMetadata({
    runId,
    taskId: task.taskId,
    repoId: task.repoId,
    status: 'QUEUED',
    branchName: options?.branchName ?? `agent/${task.taskId}/${runId}`,
    baseRunId: options?.baseRunId,
    changeRequest: options?.changeRequest,
    reviewUrl: options?.reviewUrl,
    reviewNumber: options?.reviewNumber,
    reviewProvider: options?.reviewProvider,
    reviewState: options?.reviewState,
    reviewMergedAt: options?.reviewMergedAt,
    prUrl: options?.prUrl,
    prNumber: options?.prNumber,
    landedOnDefaultBranch: options?.landedOnDefaultBranch,
    landedOnDefaultBranchAt: options?.landedOnDefaultBranchAt,
    dependencyContext: options?.dependencyContext,
    errors: [],
    startedAt: nowIso,
    timeline: [{ status: 'QUEUED', at: nowIso, note: 'Run queued for real sandbox execution.' }],
    currentStepStartedAt: nowIso,
    simulationProfile: task.uiMeta?.simulationProfile ?? 'happy_path',
    pendingEvents: [],
    previewStatus: 'UNKNOWN',
    evidenceStatus: 'NOT_STARTED',
    executorType: 'sandbox',
    orchestrationMode: 'workflow',
    llmAdapter,
    llmSupportsResume: DEFAULT_SUPPORTS_RESUME_BY_ADAPTER[llmAdapter],
    llmModel: taskUiMeta?.llmModel,
    llmReasoningEffort: taskUiMeta?.llmReasoningEffort,
    executionSummary: {}
  }));
}

export function applyRunTransition(run: AgentRun, patch: RunTransitionPatch, nowIso: string): AgentRun {
  const nextStatus = patch.status ?? run.status;
  const timeline = nextStatus !== run.status || patch.appendTimelineNote
    ? [...run.timeline, { status: nextStatus, at: nowIso, note: patch.appendTimelineNote }]
    : run.timeline;

  return normalizeRunLlmState(normalizeRunReviewMetadata({
    ...run,
    ...patch,
    status: nextStatus,
    timeline,
    currentStepStartedAt: patch.currentStepStartedAt ?? (nextStatus !== run.status ? nowIso : run.currentStepStartedAt),
    executionSummary: patch.executionSummary ? { ...run.executionSummary, ...patch.executionSummary } : run.executionSummary,
    artifactManifest: patch.artifactManifest ?? run.artifactManifest,
    artifacts: patch.artifacts ?? run.artifacts,
    errors: run.errors,
    pendingEvents: run.pendingEvents
  }));
}

export function appendRunError(run: AgentRun, error: RunError, nowIso: string): AgentRun {
  return applyRunTransition(
    {
      ...run,
      errors: [...run.errors, error]
    },
    {
      status: 'FAILED',
      endedAt: nowIso,
      appendTimelineNote: error.message,
      previewStatus: run.previewStatus === 'READY' ? 'READY' : run.previewStatus,
      evidenceStatus: run.evidenceStatus === 'READY' ? 'READY' : run.evidenceStatus
    },
    nowIso
  );
}

export function buildRunLog(runId: string, message: string, phase: RunError['phase'], level: RunLogEntry['level'] = 'info', metadata?: Record<string, string | number | boolean>): RunLogEntry {
  const createdAt = new Date().toISOString();
  return {
    id: `${runId}_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    createdAt,
    level,
    message,
    phase,
    metadata
  };
}

export function buildArtifactManifest(run: AgentRun, task: Task, repo: Repo, environmentId: string): ArtifactManifest {
  return {
    logs: {
      key: `runs/${run.runId}/logs/executor.txt`,
      label: 'Executor logs'
    },
    before: {
      key: `runs/${run.runId}/evidence/before.png`,
      label: 'Before screenshot',
      url: repo.baselineUrl
    },
    after: run.previewUrl
      ? {
          key: `runs/${run.runId}/evidence/after.png`,
          label: 'After screenshot',
          url: run.previewUrl
        }
      : undefined,
    trace: {
      key: `runs/${run.runId}/evidence/trace.zip`,
      label: 'Playwright trace',
      url: `r2://runs/${run.runId}/evidence/trace.zip`
    },
    video: {
      key: `runs/${run.runId}/evidence/video.mp4`,
      label: 'Playwright video',
      url: `r2://runs/${run.runId}/evidence/video.mp4`
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      environmentId,
      workflowInstanceId: run.workflowInstanceId,
      sandboxId: run.sandboxId,
      evidenceSandboxId: run.evidenceSandboxId,
      previewUrl: run.previewUrl,
      baselineUrl: task.baselineUrlOverride ?? repo.baselineUrl
    }
  };
}
