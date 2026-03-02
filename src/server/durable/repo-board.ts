import type { CreateTaskInput, UpdateTaskInput } from '../../ui/domain/api';
import type { AgentRun, Repo, RunError, RunLogEntry, Task, TaskDetail, TaskStatus } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { notFound } from '../http/errors';
import { createRunId, createTaskId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { EMPTY_REPO_BOARD_STATE, type RepoBoardState } from '../shared/state';
import { applyRunTransition, appendRunError, buildArtifactManifest, createRealRun, type RunTransitionPatch } from '../shared/real-run';

const STORAGE_KEY = 'repo-board-state';

type RepoScopedEvent = BoardEvent & { repoId?: string };

export class RepoBoardDO extends DurableObject<Env> {
  private state: RepoBoardState = EMPTY_REPO_BOARD_STATE;
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get<RepoBoardState>(STORAGE_KEY)) ?? EMPTY_REPO_BOARD_STATE;
    });
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      return this.handleWebSocket();
    }

    return new Response('Not found', { status: 404 });
  }

  async getBoardSlice(): Promise<RepoBoardState> {
    await this.ready;
    return this.cloneState();
  }

  async replaceState(nextState: RepoBoardState) {
    await this.ready;
    this.state = cloneRepoBoardState(nextState);
    await this.persist();
  }

  async hasTask(taskId: string) {
    await this.ready;
    return this.state.tasks.some((task) => task.taskId === taskId);
  }

  async hasRun(runId: string) {
    await this.ready;
    return this.state.runs.some((run) => run.runId === runId);
  }

  async listTasks() {
    await this.ready;
    return [...this.state.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    await this.ready;
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw notFound(`Task ${taskId} not found.`, { taskId });
    }

    const repo = await this.getRepo(task.repoId);
    const runs = this.state.runs.filter((candidate) => candidate.taskId === taskId).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return { task, repo, runs, latestRun: runs[0] };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    await this.ready;
    const now = new Date().toISOString();
    const task: Task = {
      taskId: createTaskId(input.repoId),
      repoId: input.repoId,
      title: input.title,
      description: input.description,
      taskPrompt: input.taskPrompt,
      acceptanceCriteria: input.acceptanceCriteria,
      context: input.context,
      baselineUrlOverride: input.baselineUrlOverride,
      status: input.status ?? 'INBOX',
      createdAt: now,
      updatedAt: now,
      uiMeta: { simulationProfile: input.simulationProfile ?? 'happy_path' }
    };

    this.state = {
      ...this.state,
      tasks: [task, ...this.state.tasks]
    };
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task } }, input.repoId);
    return task;
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task> {
    await this.ready;
    const existing = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!existing) {
      throw notFound(`Task ${taskId} not found.`, { taskId });
    }

    const updated: Task = {
      ...existing,
      ...patch,
      context: patch.context ?? existing.context,
      acceptanceCriteria: patch.acceptanceCriteria ?? existing.acceptanceCriteria,
      uiMeta: {
        simulationProfile: patch.simulationProfile ?? existing.uiMeta?.simulationProfile ?? 'happy_path'
      },
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === taskId ? updated : candidate))
    };
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: updated } }, updated.repoId);
    return updated;
  }

  async startRun(taskId: string): Promise<AgentRun> {
    await this.ready;
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw notFound(`Task ${taskId} not found.`, { taskId });
    }

    const existing = this.state.runs.find((run) => run.taskId === taskId && !isTerminalRunStatus(run.status));
    if (existing) {
      return existing;
    }

    const now = new Date();
    const run = createRealRun(task, createRunId(task.repoId), now);

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.taskId === taskId ? { ...candidate, status: 'ACTIVE', runId: run.runId, updatedAt: now.toISOString() } : candidate
      ),
      runs: [run, ...this.state.runs]
    };
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: this.state.tasks.find((candidate) => candidate.taskId === taskId)! } }, task.repoId);
    await this.emit({ type: 'run.updated', payload: { run } }, task.repoId);
    return run;
  }

  async getRun(runId: string) {
    await this.ready;
    const run = this.state.runs.find((candidate) => candidate.runId === runId);
    if (!run) {
      throw notFound(`Run ${runId} not found.`, { runId });
    }

    return run;
  }

  async retryRun(runId: string) {
    await this.ready;
    const run = await this.getRun(runId);
    return this.startRun(run.taskId);
  }

  async retryEvidence(runId: string) {
    await this.ready;
    const run = await this.getRun(runId);
    const nowIso = new Date().toISOString();
    const updated = applyRunTransition(
      { ...run, endedAt: undefined },
      {
        status: run.previewUrl ? 'EVIDENCE_RUNNING' : 'WAITING_PREVIEW',
        previewStatus: run.previewUrl ? 'READY' : 'DISCOVERING',
        evidenceStatus: 'RUNNING',
        appendTimelineNote: 'Retrying evidence for the existing PR.'
      },
      nowIso
    );

    this.state = {
      ...this.state,
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate)),
      tasks: this.state.tasks.map((candidate) =>
        candidate.taskId === run.taskId ? { ...candidate, status: 'REVIEW', updatedAt: nowIso } : candidate
      )
    };
    await this.persist();
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    return updated;
  }

  async appendRunLogs(runId: string, logs: RunLogEntry[]) {
    await this.ready;
    const run = await this.getRun(runId);
    this.state = {
      ...this.state,
      logs: [...this.state.logs, ...logs]
    };
    await this.persist();
    await this.emit({ type: 'run.logs_appended', payload: { runId, logs } }, run.repoId);
  }

  async transitionRun(runId: string, patch: RunTransitionPatch): Promise<AgentRun> {
    await this.ready;
    const run = await this.getRun(runId);
    const nowIso = new Date().toISOString();
    const updated = applyRunTransition(run, patch, nowIso);
    const task = this.state.tasks.find((candidate) => candidate.taskId === updated.taskId);
    if (!task) {
      throw notFound(`Task ${updated.taskId} not found.`, { taskId: updated.taskId, runId });
    }

    const nextTask = {
      ...task,
      status: deriveTaskStatus(updated, task.status),
      runId: updated.runId,
      updatedAt: nowIso
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === nextTask.taskId ? nextTask : candidate)),
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate))
    };
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: nextTask } }, updated.repoId);
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    return updated;
  }

  async markRunFailed(runId: string, error: RunError): Promise<AgentRun> {
    await this.ready;
    const run = await this.getRun(runId);
    const nowIso = new Date().toISOString();
    const updated = appendRunError(run, error, nowIso);
    const task = this.state.tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw notFound(`Task ${run.taskId} not found.`, { taskId: run.taskId, runId });
    }

    const nextTask: Task = {
      ...task,
      status: updated.prUrl ? 'REVIEW' : 'FAILED',
      updatedAt: nowIso,
      runId
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === nextTask.taskId ? nextTask : candidate)),
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate))
    };
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: nextTask } }, updated.repoId);
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    return updated;
  }

  async storeArtifactManifest(runId: string) {
    await this.ready;
    const run = await this.getRun(runId);
    const task = this.state.tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw notFound(`Task ${run.taskId} not found.`, { taskId: run.taskId, runId });
    }
    const repo = await this.getRepo(run.repoId);
    const manifest = buildArtifactManifest(run, task, repo, this.ctx.id.toString());
    return this.transitionRun(runId, {
      artifactManifest: manifest,
      artifacts: [manifest.logs.key, manifest.before?.key, manifest.after?.key, manifest.trace?.key, manifest.video?.key].filter(Boolean) as string[]
    });
  }

  async getRunArtifacts(runId: string) {
    const run = await this.getRun(runId);
    return run.artifactManifest;
  }

  async getRunLogs(runId: string, tail?: number) {
    await this.ready;
    const logs = this.state.logs.filter((entry) => entry.runId === runId);
    return tail ? logs.slice(-tail) : logs;
  }

  async alarm() {
    // Stage 3 no longer uses alarm-driven mock progression.
  }

  private async handleWebSocket() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(stringifyBoardEvent({ type: 'board.snapshot', payload: await this.buildBoardPayload() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async emit(event: RepoScopedEvent, repoId: string) {
    const payload = stringifyBoardEvent(event);
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(payload);
    }
    const board = this.env.BOARD_INDEX.getByName('agentboard');
    await board.notifyRepoEvent({ ...event, repoId });
  }

  private async persist() {
    await this.ctx.storage.put(STORAGE_KEY, this.state);
  }

  private cloneState(): RepoBoardState {
    return cloneRepoBoardState(this.state);
  }

  private async getRepo(repoId: string): Promise<Repo> {
    const board = this.env.BOARD_INDEX.getByName('agentboard');
    return board.getRepo(repoId);
  }

  private async buildBoardPayload() {
    const tasks = [...this.state.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const runs = [...this.state.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const repoIds = [...new Set(tasks.map((task) => task.repoId).concat(runs.map((run) => run.repoId)))];
    const repos = await Promise.all(repoIds.map((repoId) => this.getRepo(repoId)));
    return { repos, tasks, runs, logs: [...this.state.logs] };
  }
}

function deriveTaskStatus(run: AgentRun, current: TaskStatus): TaskStatus {
  if (run.status === 'PR_OPEN' || run.status === 'WAITING_PREVIEW' || run.status === 'EVIDENCE_RUNNING' || run.status === 'DONE') {
    return 'REVIEW';
  }
  if (run.status === 'FAILED') {
    return run.prUrl ? 'REVIEW' : 'FAILED';
  }
  if (run.status === 'QUEUED' || run.status === 'BOOTSTRAPPING' || run.status === 'RUNNING_CODEX' || run.status === 'RUNNING_TESTS' || run.status === 'PUSHING_BRANCH') {
    return 'ACTIVE';
  }
  return current;
}

function isTerminalRunStatus(status: AgentRun['status']) {
  return status === 'DONE' || status === 'FAILED';
}

function cloneRepoBoardState(state: RepoBoardState): RepoBoardState {
  return {
    tasks: state.tasks.map((task) => ({ ...task, context: { ...task.context, links: task.context.links.map((link) => ({ ...link })) }, uiMeta: task.uiMeta ? { ...task.uiMeta } : undefined })),
    runs: state.runs.map((run) => ({
      ...run,
      errors: run.errors.map((error) => ({ ...error })),
      timeline: run.timeline.map((entry) => ({ ...entry })),
      pendingEvents: run.pendingEvents.map((event) => ({ ...event })),
      executionSummary: run.executionSummary ? { ...run.executionSummary } : undefined,
      artifacts: run.artifacts ? [...run.artifacts] : undefined,
      artifactManifest: run.artifactManifest
        ? {
            ...run.artifactManifest,
            logs: { ...run.artifactManifest.logs },
            before: run.artifactManifest.before ? { ...run.artifactManifest.before } : undefined,
            after: run.artifactManifest.after ? { ...run.artifactManifest.after } : undefined,
            trace: run.artifactManifest.trace ? { ...run.artifactManifest.trace } : undefined,
            video: run.artifactManifest.video ? { ...run.artifactManifest.video } : undefined,
            metadata: { ...run.artifactManifest.metadata }
          }
        : undefined
    })),
    logs: state.logs.map((log) => ({ ...log, metadata: log.metadata ? { ...log.metadata } : undefined }))
  };
}
