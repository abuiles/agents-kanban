import type {
  AgentRun,
  BoardSnapshotV1,
  AutoReviewMode,
  AutoReviewPostingMode,
  CodexModel,
  CodexReasoningEffort,
  AutoReviewProvider,
  LlmAdapter,
  LlmReasoningEffort,
  Repo,
  RepoCheckpointConfig,
  RepoSentinelConfig,
  SentinelEvent,
  SentinelRun,
  RunCommand,
  RunCheckpoint,
  RunEvent,
  RunLogEntry,
  ReviewPlaybook,
  ScmCredential,
  SimulationProfile,
  Task,
  TaskDetail,
  TaskStatus,
  TenantMember,
  TenantSeatSummary,
  TerminalBootstrap,
  SandboxRole,
  User
} from './types';

export type RepoAutoReviewInput = {
  enabled?: boolean;
  prompt?: string;
  playbookId?: string;
  provider?: AutoReviewProvider;
  postInline?: boolean;
  postingMode?: AutoReviewPostingMode;
  llmAdapter?: LlmAdapter;
  llmModel?: string;
  llmReasoningEffort?: LlmReasoningEffort;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
};
export type RepoSentinelConfigInput = {
  enabled?: boolean;
  globalMode?: boolean;
  defaultGroupTag?: string;
  reviewGate?: Partial<RepoSentinelConfig['reviewGate']>;
  mergePolicy?: Partial<RepoSentinelConfig['mergePolicy']>;
  conflictPolicy?: Partial<RepoSentinelConfig['conflictPolicy']>;
};
export type RepoCheckpointConfigInput = {
  enabled?: boolean;
  triggerMode?: RepoCheckpointConfig['triggerMode'];
  contextNotes?: Partial<RepoCheckpointConfig['contextNotes']>;
  reviewPrep?: Partial<RepoCheckpointConfig['reviewPrep']>;
};

export type RepoSentinelStartInput = {
  scopeType?: 'group' | 'global';
  scopeValue?: string;
};

export type RepoSentinelStatus = {
  repoId: string;
  config: RepoSentinelConfig;
  run?: SentinelRun;
  events: SentinelEvent[];
  diagnostics?: {
    latestEvent?: SentinelEvent;
    latestErrorEvent?: SentinelEvent;
    latestWarningEvent?: SentinelEvent;
  };
};

export type RepoSentinelActionResult = RepoSentinelStatus & {
  changed: boolean;
};

export type RequestRunChangesSelection = {
  mode: 'all' | 'include' | 'exclude' | 'freeform';
  findingIds?: string[];
  instruction?: string;
  includeReplies?: boolean;
};

export type CreateRepoInput = {
  tenantId?: string;
  slug?: string;
  scmProvider?: Repo['scmProvider'];
  scmBaseUrl?: string;
  projectPath?: string;
  llmAdapter?: Repo['llmAdapter'];
  llmModel?: Repo['llmModel'];
  llmReasoningEffort?: Repo['llmReasoningEffort'];
  llmAuthMode?: Repo['llmAuthMode'];
  llmProfileId?: string;
  llmAuthBundleR2Key?: string;
  agentsBundleR2Key?: string;
  defaultBranch?: string;
  baselineUrl: string;
  enabled?: boolean;
  autoReview?: RepoAutoReviewInput;
  sentinelConfig?: RepoSentinelConfigInput;
  checkpointConfig?: RepoCheckpointConfigInput;
  previewMode?: Repo['previewMode'];
  evidenceMode?: Repo['evidenceMode'];
  previewAdapter?: Repo['previewAdapter'];
  previewConfig?: Repo['previewConfig'];
  commitConfig?: Repo['commitConfig'];
  previewProvider?: Repo['previewProvider'];
  previewCheckName?: string;
  // Compatibility alias during migration to generic LLM executor fields.
  codexAuthBundleR2Key?: string;
};

export type UpdateRepoInput = Partial<CreateRepoInput>;

export type UpsertScmCredentialInput = {
  scmProvider: NonNullable<Repo['scmProvider']>;
  host: string;
  label?: string;
  token: string;
};

export type CreateTaskInput = {
  repoId: string;
  title: string;
  description?: string;
  sourceRef?: string;
  dependencies?: Task['dependencies'];
  dependencyState?: Task['dependencyState'];
  automationState?: Task['automationState'];
  branchSource?: Task['branchSource'];
  taskPrompt: string;
  acceptanceCriteria: string[];
  context: Task['context'];
  baselineUrlOverride?: string;
  status?: TaskStatus;
  autoReviewMode?: AutoReviewMode;
  autoReviewPrompt?: string;
  autoReviewPlaybookId?: string;
  simulationProfile?: SimulationProfile;
  llmAdapter?: LlmAdapter;
  llmModel?: string;
  llmReasoningEffort?: LlmReasoningEffort;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
  tags?: string[];
};

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, 'repoId'>> & {
  repoId?: string;
  archived?: boolean;
  status?: TaskStatus;
  runId?: string | undefined;
};

export type RequestRunChangesInput = {
  prompt: string;
  reviewSelection?: RequestRunChangesSelection;
};

export type RetryRunInput = {
  recoveryMode?: 'latest_checkpoint' | 'fresh';
  checkpointId?: string;
};

export type CancelRunInput = {
  reason?: string;
};

export type TakeOverRunInput = {
  sandboxRole?: SandboxRole;
};

export type AuthSession = {
  user: User;
  memberships: TenantMember[];
};

export type AuthLoginInput = {
  email: string;
  password: string;
};

export type AcceptInviteInput = {
  inviteId: string;
  token: string;
  password: string;
  displayName?: string;
};

export type CreateInviteInput = {
  email: string;
  role?: 'owner' | 'member';
};

export type InviteRecord = {
  id: string;
  tenantId: string;
  email: string;
  role: 'owner' | 'member';
  status: 'pending' | 'accepted' | 'revoked';
  createdByUserId: string;
  acceptedByUserId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateInviteResult = {
  invite: InviteRecord;
  token: string;
  seatSummary: TenantSeatSummary;
};

export type UserApiTokenRecord = {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type CreateUserApiTokenInput = {
  name: string;
  scopes?: string[];
  expiresAt?: string;
};

export type CreateUserApiTokenResult = {
  tokenRecord: UserApiTokenRecord;
  token: string;
};

export type CreateReviewPlaybookInput = {
  name: string;
  prompt: string;
  enabled?: boolean;
};

export type UpdateReviewPlaybookInput = Partial<CreateReviewPlaybookInput>;

export interface AgentBoardApi {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardSnapshotV1;
  getAuthSession(): Promise<AuthSession | undefined>;
  login(input: AuthLoginInput): Promise<AuthSession>;
  acceptInvite(input: AcceptInviteInput): Promise<AuthSession>;
  logout(): Promise<void>;
  createInvite(input: CreateInviteInput): Promise<CreateInviteResult>;
  listInvites(): Promise<InviteRecord[]>;
  createApiToken(input: CreateUserApiTokenInput): Promise<CreateUserApiTokenResult>;
  listApiTokens(): Promise<UserApiTokenRecord[]>;
  revokeApiToken(tokenId: string): Promise<void>;
  listReviewPlaybooks(): Promise<ReviewPlaybook[]>;
  createReviewPlaybook(input: CreateReviewPlaybookInput): Promise<ReviewPlaybook>;
  updateReviewPlaybook(playbookId: string, patch: UpdateReviewPlaybookInput): Promise<ReviewPlaybook>;
  deleteReviewPlaybook(playbookId: string): Promise<{ playbookId: string; deleted: true }>;
  createRepo(input: CreateRepoInput): Promise<Repo>;
  listRepos(): Promise<Repo[]>;
  updateRepo(repoId: string, patch: UpdateRepoInput): Promise<Repo>;
  deleteRepo(repoId: string): Promise<{ repoId: string; deleted: true }>;
  getRepoSentinel(repoId: string): Promise<RepoSentinelStatus>;
  updateRepoSentinelConfig(repoId: string, patch: RepoSentinelConfigInput): Promise<RepoSentinelStatus>;
  startRepoSentinel(repoId: string, input?: RepoSentinelStartInput): Promise<RepoSentinelActionResult>;
  pauseRepoSentinel(repoId: string): Promise<RepoSentinelActionResult>;
  resumeRepoSentinel(repoId: string): Promise<RepoSentinelActionResult>;
  stopRepoSentinel(repoId: string): Promise<RepoSentinelActionResult>;
  listRepoSentinelEvents(repoId: string, options?: { limit?: number }): Promise<SentinelEvent[]>;
  listScmCredentials(): Promise<ScmCredential[]>;
  getScmCredential(scmProvider: UpsertScmCredentialInput['scmProvider'], host: string): Promise<ScmCredential | undefined>;
  upsertScmCredential(input: UpsertScmCredentialInput): Promise<ScmCredential>;
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(filter?: { repoId?: string; tags?: string[] }): Promise<Task[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  getTaskCheckpoints(taskId: string, options?: { latest?: boolean }): Promise<RunCheckpoint[]>;
  updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task>;
  startRun(taskId: string): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun>;
  getRunCheckpoints(runId: string): Promise<RunCheckpoint[]>;
  retryRun(runId: string, input?: RetryRunInput): Promise<AgentRun>;
  cancelRun(runId: string, input?: CancelRunInput): Promise<AgentRun>;
  rerunReview(runId: string): Promise<AgentRun>;
  requestRunChanges(runId: string, input: RequestRunChangesInput): Promise<AgentRun>;
  retryPreview(runId: string): Promise<AgentRun>;
  retryEvidence(runId: string): Promise<AgentRun>;
  takeOverRun(runId: string, input?: TakeOverRunInput): Promise<AgentRun>;
  getRunLogs(runId: string, options?: { tail?: number }): Promise<RunLogEntry[]>;
  getRunEvents(runId: string): Promise<RunEvent[]>;
  getRunCommands(runId: string): Promise<RunCommand[]>;
  getTerminalBootstrap(runId: string, sandboxRole?: SandboxRole): Promise<TerminalBootstrap>;
  exportState(): string;
  importState(serialized: string): Promise<void>;
  getSelectedRepoId(): string | 'all';
  setSelectedRepoId(repoId: string | 'all'): Promise<void>;
  getSelectedTaskId(): string | undefined;
  setSelectedTaskId(taskId?: string): Promise<void>;
}
