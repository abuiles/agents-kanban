import type { CreateTaskInput, UpdateTaskInput } from '../../ui/domain/api';
import type { AgentRun, Repo, RunLogEntry, Task, TaskDetail } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { getLatestRunForTask } from '../../ui/domain/selectors';
import { badRequest, notFound } from '../http/errors';
import { createRun, consumePendingEvent, deriveTaskStatus, buildLogsForStatus, buildArtifactManifest, isTerminalRunStatus, retryEvidence as retryEvidenceRun } from '../shared/mock-engine';
import { createRunId, createTaskId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { EMPTY_REPO_BOARD_STATE, type RepoBoardState } from '../shared/state';

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
    await this.scheduleNextAlarm();
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

    if (task.status === 'ACTIVE') {
      await this.startRun(task.taskId);
      const latest = this.state.tasks.find((candidate) => candidate.taskId === task.taskId);
      return latest ?? task;
    }

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

    if (patch.status === 'ACTIVE') {
      await this.startRun(taskId);
      return this.state.tasks.find((candidate) => candidate.taskId === taskId) ?? updated;
    }

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
    const run = createRun(task, now);
    run.runId = createRunId(task.repoId);
    run.branchName = `agent/${task.taskId}/${run.runId}`;

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.taskId === taskId ? { ...candidate, status: 'ACTIVE', runId: run.runId, updatedAt: now.toISOString() } : candidate
      ),
      runs: [run, ...this.state.runs]
    };
    await this.persist();
    await this.processDueEvents(now.toISOString());
    return this.state.runs.find((candidate) => candidate.runId === run.runId) ?? run;
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
    const task = this.state.tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw notFound(`Task ${run.taskId} not found.`, { taskId: run.taskId, runId });
    }

    await this.updateTask(task.taskId, { status: 'ACTIVE' });
    return this.state.runs.find((candidate) => candidate.taskId === task.taskId && !isTerminalRunStatus(candidate.status)) ?? run;
  }

  async retryEvidence(runId: string) {
    await this.ready;
    const run = await this.getRun(runId);
    const next = retryEvidenceRun(run, new Date().toISOString());
    this.state = {
      ...this.state,
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? next : candidate))
    };
    await this.persist();
    await this.emit({ type: 'run.updated', payload: { run: next } }, next.repoId);
    await this.processDueEvents(new Date().toISOString());
    return this.state.runs.find((candidate) => candidate.runId === runId) ?? next;
  }

  async getRunLogs(runId: string, tail?: number) {
    await this.ready;
    const logs = this.state.logs.filter((entry) => entry.runId === runId);
    return tail ? logs.slice(-tail) : logs;
  }

  async processDueEvents(nowIso = new Date().toISOString()) {
    await this.ready;
    let mutated = false;
    const emitted: Array<{ event: RepoScopedEvent; logs?: RunLogEntry[] }> = [];
    const nowMs = new Date(nowIso).getTime();

    while (true) {
      const due = this.findNextDueEvent(nowMs);
      if (!due) {
        break;
      }

      const { run, event } = due;
      const task = this.state.tasks.find((candidate) => candidate.taskId === run.taskId);
      if (!task) {
        break;
      }

      const repo = await this.getRepo(run.repoId);
      const updatedRun: AgentRun = {
        ...run,
        status: event.status,
        pendingEvents: consumePendingEvent(run, event.status, event.note),
        currentStepStartedAt: nowIso,
        timeline: [...run.timeline, { status: event.status, at: nowIso, note: event.note }]
      };

      if (event.status === 'PR_OPEN') {
        updatedRun.prNumber = updatedRun.prNumber ?? Math.floor((Date.now() / 1_000) % 10_000);
        updatedRun.prUrl = updatedRun.prUrl ?? `https://github.com/mock/${repo.slug}/pull/${updatedRun.prNumber}`;
        updatedRun.headSha = updatedRun.headSha ?? updatedRun.runId.slice(-7);
      }

      if (event.status === 'WAITING_PREVIEW') {
        updatedRun.previewUrl = updatedRun.previewUrl ?? `https://preview.example.invalid/${repo.slug.replace('/', '-')}/${updatedRun.prNumber ?? 0}`;
      }

      if (event.status === 'FAILED' && event.note) {
        updatedRun.errors = [...updatedRun.errors, { at: nowIso, message: event.note }];
        updatedRun.endedAt = nowIso;
      }

      if (event.status === 'DONE') {
        updatedRun.endedAt = nowIso;
      }

      if (event.status === 'EVIDENCE_RUNNING' || event.status === 'DONE') {
        updatedRun.artifactManifest = buildArtifactManifest(updatedRun, task, repo);
        updatedRun.artifacts = [
          updatedRun.artifactManifest.logs.key,
          updatedRun.artifactManifest.before?.key ?? '',
          updatedRun.artifactManifest.after?.key ?? ''
        ].filter(Boolean);
      }

      const nextTask: Task = {
        ...task,
        status: deriveTaskStatus(task.status, event.status),
        runId: updatedRun.runId,
        updatedAt: nowIso
      };

      const generatedLogs = buildLogsForStatus(updatedRun, event.status, nowIso);
      if (event.status === 'FAILED' && event.note) {
        generatedLogs.push({
          id: `${updatedRun.runId}_failed_${nowIso}`,
          runId: updatedRun.runId,
          createdAt: nowIso,
          level: 'error',
          message: event.note
        });
      }

      this.state = {
        tasks: this.state.tasks.map((candidate) => (candidate.taskId === nextTask.taskId ? nextTask : candidate)),
        runs: this.state.runs.map((candidate) => (candidate.runId === updatedRun.runId ? updatedRun : candidate)),
        logs: [...this.state.logs, ...generatedLogs]
      };

      emitted.push({ event: { type: 'task.updated', payload: { task: nextTask } }, logs: undefined });
      emitted.push({ event: { type: 'run.updated', payload: { run: updatedRun } }, logs: generatedLogs });
      mutated = true;
    }

    if (mutated) {
      await this.persist();
      for (const item of emitted) {
        if (item.event.type === 'task.updated') {
          await this.emit(item.event, item.event.payload.task.repoId);
        }
        if (item.event.type === 'run.updated') {
          await this.emit(item.event, item.event.payload.run.repoId);
          if (item.logs?.length) {
            await this.emit({ type: 'run.logs_appended', payload: { runId: item.event.payload.run.runId, logs: item.logs } }, item.event.payload.run.repoId);
          }
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  async alarm() {
    await this.processDueEvents(new Date().toISOString());
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

  private async scheduleNextAlarm() {
    const nextEvent = this.state.runs
      .flatMap((run) => run.pendingEvents)
      .sort((left, right) => left.executeAt.localeCompare(right.executeAt))[0];

    if (nextEvent) {
      await this.ctx.storage.setAlarm(new Date(nextEvent.executeAt));
      return;
    }

    await this.ctx.storage.deleteAlarm();
  }

  private findNextDueEvent(nowMs: number) {
    const ordered = this.state.runs
      .flatMap((run) =>
        run.pendingEvents.map((event) => ({ run, event, executeAt: new Date(event.executeAt).getTime() }))
      )
      .sort((left, right) => left.executeAt - right.executeAt);

    return ordered.find((candidate) => candidate.executeAt <= nowMs);
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

function cloneRepoBoardState(state: RepoBoardState): RepoBoardState {
  return {
    tasks: state.tasks.map((task) => ({ ...task, context: { ...task.context, links: task.context.links.map((link) => ({ ...link })) }, uiMeta: task.uiMeta ? { ...task.uiMeta } : undefined })),
    runs: state.runs.map((run) => ({
      ...run,
      errors: run.errors.map((error) => ({ ...error })),
      timeline: run.timeline.map((entry) => ({ ...entry })),
      pendingEvents: run.pendingEvents.map((event) => ({ ...event })),
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
    logs: state.logs.map((log) => ({ ...log }))
  };
}
