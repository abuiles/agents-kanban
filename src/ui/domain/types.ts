export type TaskStatus = 'INBOX' | 'READY' | 'ACTIVE' | 'REVIEW' | 'DONE' | 'FAILED';

export type RunStatus =
  | 'QUEUED'
  | 'BOOTSTRAPPING'
  | 'RUNNING_CODEX'
  | 'RUNNING_TESTS'
  | 'PUSHING_BRANCH'
  | 'PR_OPEN'
  | 'WAITING_PREVIEW'
  | 'EVIDENCE_RUNNING'
  | 'DONE'
  | 'FAILED';

export type SimulationProfile = 'happy_path' | 'fail_tests' | 'fail_preview';

export type Repo = {
  repoId: string;
  slug: string;
  defaultBranch: string;
  baselineUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskContextLink = {
  id: string;
  label: string;
  url: string;
};

export type TaskContext = {
  links: TaskContextLink[];
  notes?: string;
};

export type TaskUiMeta = {
  simulationProfile?: SimulationProfile;
};

export type Task = {
  taskId: string;
  repoId: string;
  title: string;
  description?: string;
  taskPrompt: string;
  acceptanceCriteria: string[];
  context: TaskContext;
  status: TaskStatus;
  baselineUrlOverride?: string;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  uiMeta?: TaskUiMeta;
};

export type ArtifactPointer = {
  key: string;
  label: string;
  url: string;
};

export type ArtifactManifest = {
  logs: { key: string; label: string };
  before?: ArtifactPointer;
  after?: ArtifactPointer;
  trace?: ArtifactPointer;
  video?: ArtifactPointer;
  metadata: {
    generatedAt: string;
    simulatorVersion: string;
    environmentId: string;
  };
};

export type RunTimelineEntry = {
  status: RunStatus;
  at: string;
  note?: string;
};

export type RunError = {
  at: string;
  message: string;
};

export type ScheduledSimulationEvent = {
  status: RunStatus;
  executeAt: string;
  note?: string;
};

export type AgentRun = {
  runId: string;
  taskId: string;
  repoId: string;
  status: RunStatus;
  branchName: string;
  headSha?: string;
  prUrl?: string;
  prNumber?: number;
  previewUrl?: string;
  artifacts?: string[];
  artifactManifest?: ArtifactManifest;
  errors: RunError[];
  startedAt: string;
  endedAt?: string;
  timeline: RunTimelineEntry[];
  currentStepStartedAt?: string;
  simulationProfile: SimulationProfile;
  pendingEvents: ScheduledSimulationEvent[];
};

export type RunLogEntry = {
  id: string;
  runId: string;
  createdAt: string;
  level: 'info' | 'error';
  message: string;
};

export type TaskDetail = {
  task: Task;
  repo: Repo;
  runs: AgentRun[];
  latestRun?: AgentRun;
};

export type BoardSnapshotV1 = {
  version: 1;
  repos: Repo[];
  tasks: Task[];
  runs: AgentRun[];
  logs: RunLogEntry[];
  ui: {
    selectedRepoId: string | 'all';
    selectedTaskId?: string;
    seeded: boolean;
  };
};
