import type { AgentRun, BoardSnapshotV1, CodexModel, CodexReasoningEffort, Repo, RunLogEntry, SimulationProfile, Task, TaskDetail, TaskStatus } from './types';

export type CreateRepoInput = {
  slug: string;
  defaultBranch?: string;
  baselineUrl: string;
  enabled?: boolean;
  previewCheckName?: string;
  codexAuthBundleR2Key?: string;
};

export type UpdateRepoInput = Partial<CreateRepoInput>;

export type CreateTaskInput = {
  repoId: string;
  title: string;
  description?: string;
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

export interface AgentBoardApi {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BoardSnapshotV1;
  createRepo(input: CreateRepoInput): Promise<Repo>;
  listRepos(): Promise<Repo[]>;
  updateRepo(repoId: string, patch: UpdateRepoInput): Promise<Repo>;
  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(filter?: { repoId?: string }): Promise<Task[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task>;
  startRun(taskId: string): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun>;
  retryRun(runId: string): Promise<AgentRun>;
  retryPreview(runId: string): Promise<AgentRun>;
  retryEvidence(runId: string): Promise<AgentRun>;
  getRunLogs(runId: string, options?: { tail?: number }): Promise<RunLogEntry[]>;
  exportState(): string;
  importState(serialized: string): Promise<void>;
  getSelectedRepoId(): string | 'all';
  setSelectedRepoId(repoId: string | 'all'): Promise<void>;
  getSelectedTaskId(): string | undefined;
  setSelectedTaskId(taskId?: string): Promise<void>;
}
