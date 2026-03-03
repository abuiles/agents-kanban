import type {
  AgentRun,
  BoardSnapshotV1,
  CodexModel,
  CodexReasoningEffort,
  Invite,
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
  Tenant,
  TenantMember,
  TerminalBootstrap,
  UserApiToken,
  User
} from './types';

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
  previewMode?: Repo['previewMode'];
  evidenceMode?: Repo['evidenceMode'];
  previewAdapter?: Repo['previewAdapter'];
  previewConfig?: Repo['previewConfig'];
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
};

export type AuthSession = {
  user: User;
  tenant: Tenant;
  membership: TenantMember;
};

export type AuthLoginInput = {
  email: string;
  password: string;
};

export type AuthSignupInput = {
  email: string;
  password: string;
  displayName?: string;
};

export type CreateInviteInput = {
  email: string;
  role?: 'owner' | 'member';
};

export type AcceptInviteInput = {
  inviteId: string;
  token: string;
  password: string;
  displayName?: string;
};

export type CreateApiTokenInput = {
  name: string;
  scopes?: string[];
  expiresAt?: string;
};

export type CreateApiTokenResult = {
  tokenRecord: UserApiToken;
  token: string;
};

export interface AgentBoardApi {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardSnapshotV1;
  getAuthSession(): Promise<AuthSession | undefined>;
  login(input: AuthLoginInput): Promise<AuthSession>;
  signup(input: AuthSignupInput): Promise<AuthSession>;
  acceptInvite(input: AcceptInviteInput): Promise<AuthSession>;
  logout(): Promise<void>;
  listInvites(): Promise<Invite[]>;
  createInvite(input: CreateInviteInput): Promise<{ invite: Invite; token: string }>;
  listApiTokens(): Promise<UserApiToken[]>;
  createApiToken(input: CreateApiTokenInput): Promise<CreateApiTokenResult>;
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
