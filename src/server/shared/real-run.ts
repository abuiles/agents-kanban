import type { ArtifactManifest, AgentRun, Repo, RunError, RunLogEntry, RunStatus, Task } from '../../ui/domain/types';

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
  prUrl?: string;
  prNumber?: number;
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
  prUrl?: string;
  prNumber?: number;
  baseRunId?: string;
  changeRequest?: AgentRun['changeRequest'];
};

export function createRealRun(task: Task, runId: string, now = new Date(), options?: CreateRealRunOptions): AgentRun {
  const nowIso = now.toISOString();
  return {
    runId,
    taskId: task.taskId,
    repoId: task.repoId,
    status: 'QUEUED',
    branchName: options?.branchName ?? `agent/${task.taskId}/${runId}`,
    baseRunId: options?.baseRunId,
    changeRequest: options?.changeRequest,
    prUrl: options?.prUrl,
    prNumber: options?.prNumber,
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
    executionSummary: {}
  };
}

export function applyRunTransition(run: AgentRun, patch: RunTransitionPatch, nowIso: string): AgentRun {
  const nextStatus = patch.status ?? run.status;
  const timeline = nextStatus !== run.status || patch.appendTimelineNote
    ? [...run.timeline, { status: nextStatus, at: nowIso, note: patch.appendTimelineNote }]
    : run.timeline;

  return {
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
  };
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
