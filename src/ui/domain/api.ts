import type {
  AgentRun,
  BoardSnapshotV1,
  AutoReviewMode,
  CodexModel,
  CodexReasoningEffort,
  AutoReviewProvider,
  LlmAdapter,
  LlmReasoningEffort,
  Repo,
  RunCommand,
  RunEvent,
  RunLogEntry,
  ScmCredential,
  SimulationProfile,
  Task,
  TaskDetail,
  TaskStatus,
  TenantMember,
  TenantSeatSummary,
  TerminalBootstrap,
  User
} from './types';

export type RepoAutoReviewInput = {
  enabled?: boolean;
  prompt?: string;
  provider?: AutoReviewProvider;
  postInline?: boolean;
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
  llmProfileId?: string;
  llmAuthBundleR2Key?: string;
  defaultBranch?: string;
  baselineUrl: string;
  enabled?: boolean;
  autoReview?: RepoAutoReviewInput;
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
  simulationProfile?: SimulationProfile;
  llmAdapter?: LlmAdapter;
  llmModel?: string;
  llmReasoningEffort?: LlmReasoningEffort;
  codexModel?: CodexModel;
  codexReasoningEffort?: CodexReasoningEffort;
};

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, 'repoId'>> & {
  repoId?: string;
  status?: TaskStatus;
  runId?: string | undefined;
};

export type RequestRunChangesInput = {
  prompt: string;
  reviewSelection?: RequestRunChangesSelection;
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
  createRepo(input: CreateRepoInput): Promise<Repo>;
  listRepos(): Promise<Repo[]>;
  updateRepo(repoId: string, patch: UpdateRepoInput): Promise<Repo>;
  listScmCredentials(): Promise<ScmCredential[]>;
  getScmCredential(scmProvider: UpsertScmCredentialInput['scmProvider'], host: string): Promise<ScmCredential | undefined>;
  upsertScmCredential(input: UpsertScmCredentialInput): Promise<ScmCredential>;
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(filter?: { repoId?: string }): Promise<Task[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task>;
  startRun(taskId: string): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun>;
  retryRun(runId: string): Promise<AgentRun>;
  requestRunChanges(runId: string, input: RequestRunChangesInput): Promise<AgentRun>;
  retryPreview(runId: string): Promise<AgentRun>;
  retryEvidence(runId: string): Promise<AgentRun>;
  takeOverRun(runId: string): Promise<AgentRun>;
  getRunLogs(runId: string, options?: { tail?: number }): Promise<RunLogEntry[]>;
  getRunEvents(runId: string): Promise<RunEvent[]>;
  getRunCommands(runId: string): Promise<RunCommand[]>;
  getTerminalBootstrap(runId: string): Promise<TerminalBootstrap>;
  exportState(): string;
  importState(serialized: string): Promise<void>;
  getSelectedRepoId(): string | 'all';
  setSelectedRepoId(repoId: string | 'all'): Promise<void>;
  getSelectedTaskId(): string | undefined;
  setSelectedTaskId(taskId?: string): Promise<void>;
}
