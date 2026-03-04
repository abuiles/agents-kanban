export type TaskStatus = 'INBOX' | 'READY' | 'ACTIVE' | 'REVIEW' | 'DONE' | 'FAILED';

export type RunStatus =
  | 'QUEUED'
  | 'BOOTSTRAPPING'
  | 'RUNNING_CODEX'
  | 'OPERATOR_CONTROLLED'
  | 'RUNNING_TESTS'
  | 'PUSHING_BRANCH'
  | 'PR_OPEN'
  | 'WAITING_PREVIEW'
  | 'EVIDENCE_RUNNING'
  | 'DONE'
  | 'FAILED';

export type SimulationProfile = 'happy_path' | 'fail_tests' | 'fail_preview';
export type CodexModel = 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.1-codex-mini';
export type CodexReasoningEffort = 'low' | 'medium' | 'high';
export type LlmAdapter = 'codex' | 'cursor_cli';
export type LlmReasoningEffort = 'low' | 'medium' | 'high';
export type ScmProvider = 'github' | 'gitlab';
export type AutoReviewProvider = 'gitlab' | 'jira';
export type ReviewProvider = ScmProvider;
export type AutoReviewMode = 'inherit' | 'on' | 'off';
export type PreviewAdapterKind = 'cloudflare_checks' | 'prompt_recipe';
export type IntegrationScopeType = 'tenant' | 'repo' | 'channel';
export type IntegrationPluginKind = 'slack' | 'jira' | 'gitlab';
export type IntegrationLoopState = 'QUEUED' | 'RUNNING' | 'MR_OPEN' | 'REVIEW_PENDING' | 'DECISION_REQUIRED' | 'RERUN_QUEUED' | 'PAUSED' | 'DONE' | 'FAILED';
export type IntegrationConfigSettings = Record<string, string | number | boolean>;
export type IntegrationConfig = {
  id: string;
  tenantId: string;
  scopeType: IntegrationScopeType;
  scopeId?: string;
  pluginKind: IntegrationPluginKind;
  enabled: boolean;
  settings: IntegrationConfigSettings;
  secretRef?: string;
  createdAt: string;
  updatedAt: string;
};
export type JiraProjectRepoMapping = {
  id: string;
  tenantId: string;
  jiraProjectKey: string;
  repoId: string;
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
export type SlackThreadBinding = {
  id: string;
  tenantId: string;
  taskId: string;
  channelId: string;
  threadTs: string;
  currentRunId?: string;
  latestReviewRound: number;
  createdAt: string;
  updatedAt: string;
};
export type RepoPreviewConfig = {
  checkName?: string;
  promptRecipe?: string;
};
export type RepoCommitConfig = {
  messageTemplate?: string;
  messageRegex?: string;
  messageExamples?: string[];
};
export type RepoAutoReview = {
  enabled: boolean;
  prompt?: string;
  provider: AutoReviewProvider;
  postInline: boolean;
};
export type ReviewFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ReviewFindingStatus = 'open' | 'addressed' | 'ignored';
export type ReviewPromptSource = 'task' | 'repo' | 'native';
export type ReviewExecutionTrigger = 'auto_on_review' | 'manual_rerun';
export type ReviewExecutionStatus = 'not_started' | 'running' | 'completed' | 'failed';
export type ReviewFinding = {
  findingId: string;
  severity: ReviewFindingSeverity;
  title: string;
  description: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  providerThreadId?: string;
  status: ReviewFindingStatus;
  replyContext?: string[];
};
export type RunReviewExecution = {
  enabled: boolean;
  trigger: ReviewExecutionTrigger;
  promptSource: ReviewPromptSource;
  status: ReviewExecutionStatus;
  round: number;
  startedAt?: string;
  endedAt?: string;
};
export type RunReviewFindingsSummary = {
  total: number;
  open: number;
  posted: number;
  provider?: AutoReviewProvider;
};
export type RunReviewArtifacts = {
  findingsJsonKey: string;
  reviewMarkdownKey: string;
};
export type PreviewResolutionStatus = 'ready' | 'pending' | 'failed' | 'timed_out';
export type PreviewDiagnostic = {
  code: string;
  level: 'info' | 'error';
  message: string;
  metadata?: Record<string, string | number | boolean>;
};
export type RunPreviewResolution = {
  adapter: PreviewAdapterKind;
  status: PreviewResolutionStatus;
  explanation: string;
  checkedAt: string;
  previewUrl?: string;
  diagnostics: PreviewDiagnostic[];
};

export type RunEventType =
  | 'run.status_changed'
  | 'command.started'
  | 'command.completed'
  | 'log.appended'
  | 'operator.attached'
  | 'operator.detached'
  | 'operator.takeover_started'
  | 'operator.takeover_ended'
  | 'codex.resume_available';

export type RunCommandPhase = 'bootstrap' | 'codex' | 'tests' | 'push' | 'pr' | 'preview' | 'evidence' | 'operator';

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  domain?: string;
  createdByUserId: string;
  defaultSeatLimit: number;
  seatLimit: number;
  settings?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
};

export type TenantMember = {
  id: string;
  tenantId: string;
  userId: string;
  role: 'owner' | 'member';
  seatState: 'active' | 'invited' | 'revoked';
  createdAt: string;
  updatedAt: string;
};

export type TenantSeatSummary = {
  tenantId: string;
  seatLimit: number;
  seatsUsed: number;
  seatsAvailable: number;
};

export type User = {
  id: string;
  email: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserSession = {
  id: string;
  userId: string;
  tenantId: string;
  activeTenantId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
};

export type Repo = {
  tenantId?: string;
  repoId: string;
  slug: string;
  scmProvider?: ScmProvider;
  scmBaseUrl?: string;
  projectPath?: string;
  llmAdapter?: LlmAdapter;
  llmProfileId?: string;
  llmAuthBundleR2Key?: string;
  defaultBranch: string;
  baselineUrl: string;
  enabled: boolean;
  githubAuthMode?: 'kv_pat';
  previewMode?: 'auto' | 'skip';
  evidenceMode?: 'auto' | 'skip';
  previewAdapter?: PreviewAdapterKind;
  previewConfig?: RepoPreviewConfig;
  commitConfig?: RepoCommitConfig;
  previewProvider?: 'cloudflare';
  previewCheckName?: string;
  previewUrlPattern?: string;
  // Compatibility alias during migration to generic LLM executor fields.
  codexAuthBundleR2Key?: string;
  autoReview?: RepoAutoReview;
  createdAt: string;
  updatedAt: string;
};

export type ScmCredential = {
  credentialId: string;
  scmProvider: ScmProvider;
  host: string;
  label?: string;
  hasSecret: boolean;
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
  upstreamReviewUrl?: string;
  upstreamReviewNumber?: number;
  upstreamReviewProvider?: ReviewProvider;
  upstreamPrNumber?: number;
  upstreamHeadSha?: string;
  resolvedRef: string;
  resolvedAt: string;
};

export type TaskUiMeta = {
  simulationProfile?: SimulationProfile;
  llmAdapter?: LlmAdapter;
  llmModel?: string;
  llmReasoningEffort?: LlmReasoningEffort;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
  autoReviewMode?: AutoReviewMode;
  autoReviewPrompt?: string;
};

export type Task = {
  tenantId?: string;
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

export type RunEvent = {
  tenantId?: string;
  id: string;
  runId: string;
  repoId: string;
  taskId: string;
  at: string;
  actorType: 'workflow' | 'sandbox' | 'system' | 'operator';
  eventType: RunEventType;
  message: string;
  metadata?: Record<string, string | number | boolean>;
};

export type RunCommand = {
  tenantId?: string;
  id: string;
  runId: string;
  phase: RunCommandPhase;
  startedAt: string;
  completedAt?: string;
  command: string;
  exitCode?: number;
  status: 'running' | 'completed' | 'failed';
  source: 'system' | 'operator';
  stdoutPreview?: string;
  stderrPreview?: string;
};

export type OperatorSession = {
  tenantId?: string;
  id: string;
  runId: string;
  sandboxId: string;
  sessionName: string;
  startedAt: string;
  endedAt?: string;
  actorId: string;
  actorLabel: string;
  connectionState: 'connecting' | 'open' | 'closed' | 'failed';
  takeoverState: 'codex_control' | 'observing' | 'operator_control' | 'resumable';
  llmAdapter?: LlmAdapter;
  llmSupportsResume?: boolean;
  llmSessionId?: string;
  llmResumeCommand?: string;
  codexThreadId?: string;
  codexResumeCommand?: string;
  closeReason?: string;
};

export type TerminalBootstrap = {
  tenantId?: string;
  runId: string;
  repoId: string;
  taskId: string;
  sandboxId: string;
  sessionName: string;
  status: RunStatus;
  attachable: boolean;
  reason?: string;
  wsPath?: string;
  cols: number;
  rows: number;
  session?: OperatorSession;
  llmSupportsResume?: boolean;
  llmResumeCommand?: string;
  codexResumeCommand?: string;
};

export type ArtifactManifest = {
  logs: { key: string; label: string; url?: string };
  before?: ArtifactPointer;
  after?: ArtifactPointer;
  trace?: ArtifactPointer;
  video?: ArtifactPointer;
  reviewFindingsJson?: ArtifactPointer;
  reviewMarkdown?: ArtifactPointer;
  metadata: {
    tenantId?: string;
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
  tenantId?: string;
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
  reviewUrl?: string;
  reviewNumber?: number;
  reviewProvider?: ReviewProvider;
  reviewState?: 'open' | 'merged' | 'closed';
  reviewMergedAt?: string;
  prUrl?: string;
  prNumber?: number;
  landedOnDefaultBranch?: boolean;
  landedOnDefaultBranchAt?: string;
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
  codexProcessId?: string;
  currentCommandId?: string;
  loopState?: IntegrationLoopState;
  llmAdapter?: LlmAdapter;
  llmSupportsResume?: boolean;
  llmModel?: string;
  llmReasoningEffort?: LlmReasoningEffort;
  llmResumeCommand?: string;
  llmSessionId?: string;
  latestCodexResumeCommand?: string;
  operatorSession?: OperatorSession;
  dependencyContext?: {
    sourceTaskId?: string;
    sourceRunId?: string;
    sourceReviewUrl?: string;
    sourceReviewNumber?: number;
    sourceReviewProvider?: ReviewProvider;
    sourcePrNumber?: number;
    sourceHeadSha?: string;
    sourceMode: 'explicit_source_ref' | 'dependency_review_head' | 'default_branch';
  };
  executionSummary?: {
    codexOutcome?: 'changes' | 'no_changes' | 'failed';
    testsOutcome?: 'passed' | 'failed' | 'skipped';
    prCommented?: boolean;
    previewResolution?: RunPreviewResolution;
  };
  reviewExecution?: RunReviewExecution;
  reviewFindings?: ReviewFinding[];
  reviewFindingsSummary?: RunReviewFindingsSummary;
  reviewArtifacts?: RunReviewArtifacts;
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
  events: RunEvent[];
  commands: RunCommand[];
  ui: {
    selectedRepoId: string | 'all';
    selectedTaskId?: string;
    seeded: boolean;
  };
};
