import type { AgentBoardApi, CreateRepoInput, CreateTaskInput, UpdateRepoInput, UpdateTaskInput } from '../domain/api';
import type { AgentRun, Repo, RunLogEntry, Task, TaskDetail } from '../domain/types';
import { getTaskDetail, getTasksForRepo } from '../domain/selectors';
import { LocalBoardStore } from '../store/local-board-store';
import { parseImportedBoard } from '../store/import-export';
import { RunSimulator } from './run-simulator';

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export class LocalAgentBoardApi implements AgentBoardApi {
  private readonly simulator: RunSimulator;

  constructor(private readonly store: LocalBoardStore) {
    this.simulator = new RunSimulator(store);
    this.simulator.resumeAll();
  }

  subscribe(listener: () => void) {
    return this.store.subscribe(listener);
  }

  getSnapshot() {
    return this.store.getSnapshot();
  }

  async createRepo(input: CreateRepoInput): Promise<Repo> {
    const timestamp = nowIso();
    const repo: Repo = {
      repoId: randomId('repo'),
      slug: input.slug,
      defaultBranch: input.defaultBranch ?? 'main',
      baselineUrl: input.baselineUrl,
      enabled: input.enabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.store.update((snapshot) => ({ ...snapshot, repos: [repo, ...snapshot.repos] }));
    return repo;
  }

  async listRepos(): Promise<Repo[]> {
    return this.store.getSnapshot().repos;
  }

  async updateRepo(repoId: string, patch: UpdateRepoInput): Promise<Repo> {
    let updatedRepo: Repo | undefined;
    this.store.update((snapshot) => ({
      ...snapshot,
      repos: snapshot.repos.map((repo) => {
        if (repo.repoId !== repoId) {
          return repo;
        }

        updatedRepo = { ...repo, ...patch, updatedAt: nowIso() };
        return updatedRepo;
      })
    }));

    if (!updatedRepo) {
      throw new Error(`Repo ${repoId} not found.`);
    }

    return updatedRepo;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const timestamp = nowIso();
    const task: Task = {
      taskId: randomId('task'),
      repoId: input.repoId,
      title: input.title,
      description: input.description,
      taskPrompt: input.taskPrompt,
      acceptanceCriteria: input.acceptanceCriteria,
      context: input.context,
      baselineUrlOverride: input.baselineUrlOverride,
      status: input.status ?? 'INBOX',
      createdAt: timestamp,
      updatedAt: timestamp,
      uiMeta: { simulationProfile: input.simulationProfile ?? 'happy_path' }
    };

    this.store.update((snapshot) => ({
      ...snapshot,
      tasks: [task, ...snapshot.tasks],
      ui: { ...snapshot.ui, selectedTaskId: task.taskId }
    }));

    return task;
  }

  async listTasks(filter?: { repoId?: string }): Promise<Task[]> {
    return getTasksForRepo(this.store.getSnapshot().tasks, filter?.repoId ?? 'all');
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    const detail = getTaskDetail(this.store.getSnapshot(), taskId);
    if (!detail) {
      throw new Error(`Task ${taskId} not found.`);
    }

    return detail;
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task> {
    let updatedTask: Task | undefined;
    this.store.update((snapshot) => ({
      ...snapshot,
      tasks: snapshot.tasks.map((task) => {
        if (task.taskId !== taskId) {
          return task;
        }

        updatedTask = {
          ...task,
          ...patch,
          context: patch.context ?? task.context,
          acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria,
          uiMeta: {
            simulationProfile: patch.simulationProfile ?? task.uiMeta?.simulationProfile ?? 'happy_path'
          },
          updatedAt: nowIso()
        };
        return updatedTask;
      })
    }));

    if (!updatedTask) {
      throw new Error(`Task ${taskId} not found.`);
    }

    if (patch.status === 'ACTIVE') {
      return this.updateTaskStatusAndStartRun(updatedTask);
    }

    return updatedTask;
  }

  async startRun(taskId: string): Promise<AgentRun> {
    const snapshot = this.store.getSnapshot();
    const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const existing = snapshot.runs.find((run) => run.taskId === taskId && !['DONE', 'FAILED'].includes(run.status));
    if (existing) {
      return existing;
    }

    return this.simulator.createRun(task);
  }

  async getRun(runId: string): Promise<AgentRun> {
    const run = this.store.getSnapshot().runs.find((candidate) => candidate.runId === runId);
    if (!run) {
      throw new Error(`Run ${runId} not found.`);
    }

    return run;
  }

  async retryRun(runId: string): Promise<AgentRun> {
    const run = await this.getRun(runId);
    const task = this.store.getSnapshot().tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw new Error(`Task ${run.taskId} not found.`);
    }

    return this.simulator.createRun({
      ...task,
      status: 'ACTIVE',
      updatedAt: nowIso()
    });
  }

  async retryPreview(runId: string): Promise<AgentRun> {
    return this.simulator.retryPreview(runId);
  }

  async retryEvidence(runId: string): Promise<AgentRun> {
    return this.simulator.retryEvidence(runId);
  }

  async getRunLogs(runId: string, options?: { tail?: number }): Promise<RunLogEntry[]> {
    const logs = this.store.getSnapshot().logs.filter((log) => log.runId === runId);
    return options?.tail ? logs.slice(-options.tail) : logs;
  }

  exportState(): string {
    return this.store.export();
  }

  async importState(serialized: string) {
    this.store.replaceSnapshot(parseImportedBoard(serialized));
    this.simulator.resumeAll();
  }

  getSelectedRepoId() {
    return this.store.getSnapshot().ui.selectedRepoId;
  }

  async setSelectedRepoId(repoId: string | 'all') {
    this.store.update((snapshot) => ({ ...snapshot, ui: { ...snapshot.ui, selectedRepoId: repoId } }));
  }

  getSelectedTaskId() {
    return this.store.getSnapshot().ui.selectedTaskId;
  }

  async setSelectedTaskId(taskId?: string) {
    this.store.update((snapshot) => ({ ...snapshot, ui: { ...snapshot.ui, selectedTaskId: taskId } }));
  }

  private async updateTaskStatusAndStartRun(task: Task) {
    await this.startRun(task.taskId);
    return this.store.getSnapshot().tasks.find((candidate) => candidate.taskId === task.taskId)!;
  }
}

let singleton: LocalAgentBoardApi | undefined;

export function getLocalAgentBoardApi() {
  singleton ??= new LocalAgentBoardApi(new LocalBoardStore());
  return singleton;
}

export function resetLocalAgentBoardApi() {
  singleton = undefined;
}
