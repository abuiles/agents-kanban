import type {
  AgentRun,
  BoardSnapshotV1,
  CodexModel,
  CodexReasoningEffort,
  ProviderCredential,
  Repo,
  RunCommand,
  RunEvent,
  RunLogEntry,
  ScmProvider,
  SimulationProfile,
  Task,
  TaskDetail,
  TaskStatus,
  TerminalBootstrap
} from './types';

export type CreateRepoInput = {
  slug?: string;
  scmProvider?: ScmProvider;
  scmBaseUrl?: string;
  projectPath?: string;
  defaultBranch?: string;
  baselineUrl: string;
  enabled?: boolean;
  previewCheckName?: string;
  codexAuthBundleR2Key?: string;
};

export type UpdateRepoInput = Partial<CreateRepoInput>;

export type UpsertProviderCredentialInput = {
  scmProvider: ScmProvider;
  scmBaseUrl?: string;
  authType?: ProviderCredential['authType'];
  secretRef: ProviderCredential['secretRef'];
  label?: string;
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

export interface AgentBoardApi {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardSnapshotV1;
  createRepo(input: CreateRepoInput): Promise<Repo>;
  listRepos(): Promise<Repo[]>;
  updateRepo(repoId: string, patch: UpdateRepoInput): Promise<Repo>;
  listProviderCredentials(): Promise<ProviderCredential[]>;
  upsertProviderCredential(input: UpsertProviderCredentialInput): Promise<ProviderCredential>;
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
