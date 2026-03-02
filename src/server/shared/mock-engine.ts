import type {
  AgentRun,
  ArtifactManifest,
  Repo,
  RunLogEntry,
  RunStatus,
  ScheduledSimulationEvent,
  SimulationProfile,
  Task,
  TaskStatus
} from '../../ui/domain/types';
import { getBaselineUrl } from '../../ui/domain/selectors';

const OFFSETS: Record<Exclude<RunStatus, 'FAILED'>, number> = {
  QUEUED: 0,
  BOOTSTRAPPING: 1,
  RUNNING_CODEX: 3,
  RUNNING_TESTS: 8,
  PUSHING_BRANCH: 11,
  PR_OPEN: 13,
  WAITING_PREVIEW: 15,
  EVIDENCE_RUNNING: 19,
  DONE: 24
};

const HAPPY_PATH: Array<Exclude<RunStatus, 'FAILED'>> = [
  'QUEUED',
  'BOOTSTRAPPING',
  'RUNNING_CODEX',
  'RUNNING_TESTS',
  'PUSHING_BRANCH',
  'PR_OPEN',
  'WAITING_PREVIEW',
  'EVIDENCE_RUNNING',
  'DONE'
];

const LOG_MESSAGES: Record<RunStatus, string[]> = {
  QUEUED: ['Queued task and reserved a mock sandbox.'],
  BOOTSTRAPPING: ['Restoring Codex auth bundle and cloning repository.'],
  RUNNING_CODEX: [
    'Codex is reading the task prompt and repo context.',
    'Applying mock code edits based on acceptance criteria.',
    'Preparing branch for test execution.'
  ],
  RUNNING_TESTS: ['Running mock test suite and static checks.'],
  PUSHING_BRANCH: ['Pushing branch to origin in the mock remote.'],
  PR_OPEN: ['Opened mock pull request and attached task summary.'],
  WAITING_PREVIEW: ['Waiting for preview deployment status checks.'],
  EVIDENCE_RUNNING: ['Running mock Playwright capture against baseline and preview.'],
  DONE: ['Run finished. Artifact manifest is ready.'],
  FAILED: ['Run failed. Check mock error details for the terminal step.']
};

const TERMINAL_STATUSES: RunStatus[] = ['DONE', 'FAILED'];

export function isTerminalRunStatus(status: RunStatus) {
  return TERMINAL_STATUSES.includes(status);
}

export function buildSimulationPlan(startedAt: Date, profile: SimulationProfile): ScheduledSimulationEvent[] {
  const plan: ScheduledSimulationEvent[] = HAPPY_PATH.map((status) => ({
    status,
    executeAt: new Date(startedAt.getTime() + OFFSETS[status] * 1_000).toISOString()
  }));

  if (profile === 'fail_tests') {
    return plan
      .filter((event) => ['QUEUED', 'BOOTSTRAPPING', 'RUNNING_CODEX', 'RUNNING_TESTS'].includes(event.status))
      .concat({
        status: 'FAILED',
        executeAt: new Date(startedAt.getTime() + 9_000).toISOString(),
        note: 'Mock tests failed during auth settings suite.'
      });
  }

  if (profile === 'fail_preview') {
    return plan
      .filter((event) =>
        ['QUEUED', 'BOOTSTRAPPING', 'RUNNING_CODEX', 'RUNNING_TESTS', 'PUSHING_BRANCH', 'PR_OPEN', 'WAITING_PREVIEW'].includes(event.status)
      )
      .concat({
        status: 'FAILED',
        executeAt: new Date(startedAt.getTime() + 18_000).toISOString(),
        note: 'Preview never became ready before the mock timeout.'
      });
  }

  return plan;
}

export function buildLogsForStatus(run: AgentRun, status: RunStatus, createdAt: string): RunLogEntry[] {
  return (LOG_MESSAGES[status] ?? []).map((message, index) => ({
    id: `${run.runId}_${status}_${index}_${createdAt}`,
    runId: run.runId,
    createdAt,
    level: status === 'FAILED' ? 'error' : 'info',
    message
  }));
}

export function createRun(task: Task, now: Date): AgentRun {
  const runId = `run_${task.repoId}_${now.getTime().toString(36)}`;
  const profile = task.uiMeta?.simulationProfile ?? 'happy_path';

  return {
    runId,
    taskId: task.taskId,
    repoId: task.repoId,
    status: 'QUEUED',
    branchName: `agent/${task.taskId}/${runId}`,
    errors: [],
    startedAt: now.toISOString(),
    timeline: [],
    simulationProfile: profile,
    pendingEvents: buildSimulationPlan(now, profile)
  };
}

export function retryEvidence(run: AgentRun, nowIso: string): AgentRun {
  return {
    ...run,
    status: 'WAITING_PREVIEW',
    endedAt: undefined,
    pendingEvents: [
      { status: 'EVIDENCE_RUNNING', executeAt: nowIso },
      { status: 'DONE', executeAt: new Date(new Date(nowIso).getTime() + 4_000).toISOString() }
    ],
    timeline: [...run.timeline, { status: 'WAITING_PREVIEW', at: nowIso, note: 'Retrying evidence only.' }]
  };
}

export function consumePendingEvent(run: AgentRun, status: RunStatus, note?: string): ScheduledSimulationEvent[] {
  let consumed = false;
  return run.pendingEvents.filter((event) => {
    if (!consumed && event.status === status && event.note === note) {
      consumed = true;
      return false;
    }

    return true;
  });
}

export function deriveTaskStatus(currentStatus: TaskStatus, runStatus: RunStatus): TaskStatus {
  if (runStatus === 'PR_OPEN' || runStatus === 'WAITING_PREVIEW' || runStatus === 'EVIDENCE_RUNNING' || runStatus === 'DONE') {
    return 'REVIEW';
  }

  if (runStatus === 'FAILED') {
    return 'FAILED';
  }

  if (!isTerminalRunStatus(runStatus)) {
    return 'ACTIVE';
  }

  return currentStatus;
}

export function buildArtifactManifest(run: AgentRun, task: Task, repo: Repo | undefined): ArtifactManifest {
  const baseKey = `runs/${run.runId}`;
  return {
    logs: { key: `${baseKey}/logs.txt`, label: 'Mock logs' },
    before: {
      key: `${baseKey}/before.png`,
      label: 'Before screenshot',
      url: getBaselineUrl(task, repo)
    },
    after: {
      key: `${baseKey}/after.png`,
      label: 'After screenshot',
      url: run.previewUrl ?? 'https://preview.example.invalid/unavailable'
    },
    trace: {
      key: `${baseKey}/trace.zip`,
      label: 'Trace archive',
      url: `https://artifacts.example.invalid/${baseKey}/trace.zip`
    },
    video: {
      key: `${baseKey}/video.mp4`,
      label: 'Run video',
      url: `https://artifacts.example.invalid/${baseKey}/video.mp4`
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      simulatorVersion: 'stage-2',
      environmentId: 'worker-mock-executor'
    }
  };
}
