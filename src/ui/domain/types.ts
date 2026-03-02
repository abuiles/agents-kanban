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
export type CodexModel = 'gpt-5.3-codex' | 'gpt-5.1-codex-mini';
export type CodexReasoningEffort = 'low' | 'medium' | 'high';

export type Repo = {
  repoId: string;
  slug: string;
  defaultBranch: string;
  baselineUrl: string;
  enabled: boolean;
  githubAuthMode?: 'kv_pat';
  previewProvider?: 'cloudflare';
  previewCheckName?: string;
  previewUrlPattern?: string;
  codexAuthBundleR2Key?: string;
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

export type TaskDependency = {
  upstreamTaskId: string;
  mode: 'review_ready';
  primary?: boolean;
};

export type TaskDependencyReason = {
  upstreamTaskId: string;
  state: 'missing' | 'not_ready' | 'ready';
  message: string;
};

export type TaskDependencyState = {
  blocked: boolean;
  unblockedAt?: string;
  reasons: TaskDependencyReason[];
};

export type TaskAutomationState = {
  autoStartEligible: boolean;
  autoStartedAt?: string;
  lastDependencyRefreshAt?: string;
};

export type TaskBranchSource = {
  kind: 'explicit_source_ref' | 'dependency_review_head' | 'default_branch';
  upstreamTaskId?: string;
  upstreamRunId?: string;
  upstreamPrNumber?: number;
  upstreamHeadSha?: string;
  resolvedRef: string;
  resolvedAt: string;
};

export type TaskUiMeta = {
  simulationProfile?: SimulationProfile;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
};

export type Task = {
  taskId: string;
  repoId: string;
  title: string;
  description?: string;
  sourceRef?: string;
  dependencies?: TaskDependency[];
  dependencyState?: TaskDependencyState;
  automationState?: TaskAutomationState;
  branchSource?: TaskBranchSource;
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
  logs: { key: string; label: string; url?: string };
  before?: ArtifactPointer;
  after?: ArtifactPointer;
  trace?: ArtifactPointer;
  video?: ArtifactPointer;
  metadata: {
    generatedAt: string;
    environmentId: string;
    simulatorVersion?: string;
    workflowInstanceId?: string;
    sandboxId?: string;
    evidenceSandboxId?: string;
    previewUrl?: string;
    baselineUrl?: string;
  };
};

export type RunTimelineEntry = {
  status: RunStatus;
  at: string;
  note?: string;
};

export type RunError = {
  at: string;
  code?: string;
  retryable?: boolean;
  phase?: 'bootstrap' | 'codex' | 'tests' | 'push' | 'pr' | 'preview' | 'evidence';
  message: string;
  metadata?: Record<string, string | number | boolean>;
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
  baseRunId?: string;
  changeRequest?: {
    prompt: string;
    requestedAt: string;
  };
  headSha?: string;
  prUrl?: string;
  prNumber?: number;
  previewUrl?: string;
  previewStatus?: 'UNKNOWN' | 'DISCOVERING' | 'READY' | 'FAILED';
  evidenceStatus?: 'NOT_STARTED' | 'RUNNING' | 'READY' | 'FAILED';
  executorType?: 'mock' | 'sandbox';
  workflowInstanceId?: string;
  orchestrationMode?: 'workflow' | 'local_alarm';
  sandboxId?: string;
  evidenceSandboxId?: string;
  commitSha?: string;
  commitMessage?: string;
  dependencyContext?: {
    sourceTaskId?: string;
    sourceRunId?: string;
    sourcePrNumber?: number;
    sourceHeadSha?: string;
    sourceMode: 'explicit_source_ref' | 'dependency_review_head' | 'default_branch';
  };
  executionSummary?: {
    codexOutcome?: 'changes' | 'no_changes' | 'failed';
    testsOutcome?: 'passed' | 'failed' | 'skipped';
    prCommented?: boolean;
  };
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
  phase?: 'bootstrap' | 'codex' | 'tests' | 'push' | 'pr' | 'preview' | 'evidence';
  metadata?: Record<string, string | number | boolean>;
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
