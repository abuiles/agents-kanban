import type { CreateTaskInput, UpdateTaskInput } from '../../ui/domain/api';
import type {
  AgentRun,
  OperatorSession,
  Repo,
  RunCommand,
  RunError,
  RunEvent,
  RunLogEntry,
  Task,
  TaskDetail,
  TaskStatus,
  TerminalBootstrap
} from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { badRequest, notFound } from '../http/errors';
import { createRunId, createTaskId, extractRepoIdFromTaskId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { EMPTY_REPO_BOARD_STATE, type RepoBoardState } from '../shared/state';
import { applyRunTransition, appendRunError, buildArtifactManifest, createRealRun, type RunTransitionPatch } from '../shared/real-run';
import { executeRunJob } from '../run-orchestrator';
import { refreshDependencyStates } from '../shared/dependency-state';
import { buildLatestRunsByTaskId, isDependencyMergedToDefaultBranch } from '../shared/dependency-readiness';
import { resolveRunSource } from '../shared/run-source-resolution';
import { normalizeOperatorSession, normalizeRunLlmState, normalizeTaskUiMeta } from '../../shared/llm';
import { hasRunReview, normalizeDependencyReviewMetadata, normalizeRunReviewMetadata, normalizeTaskBranchSourceReviewMetadata } from '../../shared/scm';
import { DEFAULT_TENANT_ID, normalizeTenantId } from '../../shared/tenant';
import { writeUsageLedgerEntriesBestEffort } from '../usage-ledger';

const STORAGE_KEY = 'repo-board-state';
const LOCAL_JOBS_KEY = 'repo-board-local-jobs';
const MAX_LOG_ENTRIES = 300;
const MAX_EVENT_ENTRIES = 600;
const MAX_COMMAND_ENTRIES = 500;
const MAX_LOG_MESSAGE_CHARS = 1000;
const MAX_EVENT_MESSAGE_CHARS = 600;
const MAX_COMMAND_PREVIEW_CHARS = 1000;

type RepoScopedEvent = BoardEvent & { repoId?: string };
type LocalJobs = Record<string, 'full_run' | 'evidence_only' | 'preview_only'>;

export class RepoBoardDO extends DurableObject<Env> {
  private state: RepoBoardState = EMPTY_REPO_BOARD_STATE;
  private localJobs: LocalJobs = {};
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<RepoBoardState>(STORAGE_KEY);
      this.state = normalizeRepoBoardState(stored);
      this.localJobs = (await this.ctx.storage.get<LocalJobs>(LOCAL_JOBS_KEY)) ?? {};
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
    this.state = cloneRepoBoardState(normalizeRepoBoardState(nextState));
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
    const repo = await this.getRepo(input.repoId);
    const now = new Date().toISOString();
    const taskId = createTaskId(input.repoId);
    validateDependenciesForTask(input.repoId, taskId, input.dependencies);
    const task: Task = {
      tenantId: repo.tenantId,
      taskId,
      repoId: input.repoId,
      title: input.title,
      description: input.description,
      sourceRef: input.sourceRef,
      dependencies: cloneTaskDependencies(input.dependencies),
      dependencyState: cloneTaskDependencyState(input.dependencyState),
      automationState: cloneTaskAutomationState(input.automationState),
      branchSource: cloneTaskBranchSource(input.branchSource),
      taskPrompt: input.taskPrompt,
      acceptanceCriteria: input.acceptanceCriteria,
      context: input.context,
      baselineUrlOverride: input.baselineUrlOverride,
      status: input.status ?? 'INBOX',
      createdAt: now,
      updatedAt: now,
      uiMeta: normalizeTaskUiMeta({
        simulationProfile: input.simulationProfile ?? 'happy_path',
        llmAdapter: input.llmAdapter,
        llmModel: input.llmModel,
        llmReasoningEffort: input.llmReasoningEffort,
        codexModel: input.codexModel,
        codexReasoningEffort: input.codexReasoningEffort
      })
    };

    this.state = {
      ...this.state,
      tasks: [task, ...this.state.tasks]
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(now);
    const finalTask = this.state.tasks.find((candidate) => candidate.taskId === task.taskId) ?? task;
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: finalTask } }, input.repoId);
    await this.emitDependencyRefreshUpdates(input.repoId, refreshedTasks, [finalTask.taskId]);
    return finalTask;
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task> {
    await this.ready;
    const existing = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!existing) {
      throw notFound(`Task ${taskId} not found.`, { taskId });
    }

    if (patch.dependencies) {
      validateDependenciesForTask(existing.repoId, existing.taskId, patch.dependencies);
    }

    const hasPatchField = <K extends keyof UpdateTaskInput>(key: K) => Object.prototype.hasOwnProperty.call(patch, key);

    const updated: Task = {
      ...existing,
      ...patch,
      dependencies: hasPatchField('dependencies') ? cloneTaskDependencies(patch.dependencies) : cloneTaskDependencies(existing.dependencies),
      dependencyState: hasPatchField('dependencyState')
        ? cloneTaskDependencyState(patch.dependencyState)
        : cloneTaskDependencyState(existing.dependencyState),
      automationState: hasPatchField('automationState')
        ? cloneTaskAutomationState(patch.automationState)
        : cloneTaskAutomationState(existing.automationState),
      branchSource: hasPatchField('branchSource') ? cloneTaskBranchSource(patch.branchSource) : cloneTaskBranchSource(existing.branchSource),
      sourceRef: patch.sourceRef ?? existing.sourceRef,
      context: patch.context ?? existing.context,
      acceptanceCriteria: patch.acceptanceCriteria ?? existing.acceptanceCriteria,
      uiMeta: normalizeTaskUiMeta({
        simulationProfile: patch.simulationProfile ?? existing.uiMeta?.simulationProfile ?? 'happy_path',
        llmAdapter: patch.llmAdapter ?? existing.uiMeta?.llmAdapter,
        llmModel: patch.llmModel ?? existing.uiMeta?.llmModel,
        llmReasoningEffort: patch.llmReasoningEffort ?? existing.uiMeta?.llmReasoningEffort,
        codexModel: patch.codexModel ?? existing.uiMeta?.codexModel,
        codexReasoningEffort: patch.codexReasoningEffort ?? existing.uiMeta?.codexReasoningEffort
      }),
      updatedAt: new Date().toISOString()
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === taskId ? updated : candidate))
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(updated.updatedAt);
    const finalTask = this.state.tasks.find((candidate) => candidate.taskId === updated.taskId) ?? updated;
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: finalTask } }, updated.repoId);
    await this.emitDependencyRefreshUpdates(updated.repoId, refreshedTasks, [finalTask.taskId]);
    return finalTask;
  }

  async deleteTask(taskId: string): Promise<{ taskId: string; deleted: true }> {
    await this.ready;
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw notFound(`Task ${taskId} not found.`, { taskId });
    }
    const runIds = new Set(this.state.runs.filter((run) => run.taskId === taskId).map((run) => run.runId));

    this.state = {
      ...this.state,
      tasks: this.state.tasks.filter((candidate) => candidate.taskId !== taskId),
      runs: this.state.runs.filter((run) => run.taskId !== taskId),
      logs: this.state.logs.filter((log) => !runIds.has(log.runId)),
      events: this.state.events.filter((event) => event.taskId !== taskId),
      commands: this.state.commands.filter((command) => !runIds.has(command.runId))
    };
    await this.persist();
    return { taskId, deleted: true };
  }

  async startRun(taskId: string, options?: { forceNew?: boolean; baseRunId?: string; dependencyAutoStart?: boolean }): Promise<AgentRun> {
    await this.ready;
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      throw notFound(`Task ${taskId} not found.`, { taskId });
    }

    const existing = this.state.runs.find((run) => run.taskId === taskId && !isTerminalRunStatus(run.status));
    if (existing && !options?.forceNew) {
      return existing;
    }
    if (options?.dependencyAutoStart && task.runId) {
      const existingRun = this.state.runs.find((run) => run.runId === task.runId) ?? this.state.runs.find((run) => run.taskId === taskId);
      if (existingRun) {
        return existingRun;
      }
    }

    const repo = await this.getRepo(task.repoId);
    const now = new Date();
    const nowIso = now.toISOString();
    const resolvedSource = resolveRunSource({
      task,
      tasks: this.state.tasks,
      runs: this.state.runs,
      defaultBranch: repo.defaultBranch,
      resolvedAt: nowIso
    });
    const run = createRealRun(
      {
        ...task,
        branchSource: resolvedSource.branchSource
      },
      createRunId(task.repoId),
      now,
      {
        baseRunId: options?.baseRunId,
        dependencyContext: resolvedSource.dependencyContext
      }
    );

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.taskId === taskId
          ? {
              ...candidate,
              status: 'ACTIVE',
              runId: run.runId,
              automationState: options?.dependencyAutoStart && candidate.automationState && !candidate.automationState.autoStartedAt
                ? {
                    ...candidate.automationState,
                    autoStartedAt: nowIso
                  }
                : candidate.automationState,
              branchSource: resolvedSource.branchSource,
              updatedAt: nowIso
            }
          : candidate
      ),
      runs: [run, ...this.state.runs]
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(nowIso);
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: this.state.tasks.find((candidate) => candidate.taskId === taskId)! } }, task.repoId);
    await this.emit({ type: 'run.updated', payload: { run } }, task.repoId);
    await this.emitDependencyRefreshUpdates(task.repoId, refreshedTasks, [taskId]);
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
    return this.startRun(run.taskId, { forceNew: true, baseRunId: run.runId });
  }

  async requestRunChanges(runId: string, prompt: string) {
    await this.ready;
    const existingRun = await this.getRun(runId);
    const task = this.state.tasks.find((candidate) => candidate.taskId === existingRun.taskId);
    if (!task) {
      throw notFound(`Task ${existingRun.taskId} not found.`, { taskId: existingRun.taskId, runId });
    }

    const now = new Date();
    const nextRun = createRealRun(task, createRunId(task.repoId), now, {
      branchName: existingRun.branchName,
      reviewUrl: existingRun.reviewUrl,
      reviewNumber: existingRun.reviewNumber,
      reviewProvider: existingRun.reviewProvider,
      reviewState: existingRun.reviewState,
      reviewMergedAt: existingRun.reviewMergedAt,
      prUrl: existingRun.prUrl,
      prNumber: existingRun.prNumber,
      landedOnDefaultBranch: existingRun.landedOnDefaultBranch,
      landedOnDefaultBranchAt: existingRun.landedOnDefaultBranchAt,
      baseRunId: existingRun.runId,
      dependencyContext: existingRun.dependencyContext,
      changeRequest: {
        prompt,
        requestedAt: now.toISOString()
      }
    });

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) =>
        candidate.taskId === task.taskId ? { ...candidate, status: 'ACTIVE', runId: nextRun.runId, updatedAt: now.toISOString() } : candidate
      ),
      runs: [nextRun, ...this.state.runs]
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(now.toISOString());
    await this.persist();
    await this.emit({ type: 'task.updated', payload: { task: this.state.tasks.find((candidate) => candidate.taskId === task.taskId)! } }, task.repoId);
    await this.emit({ type: 'run.updated', payload: { run: nextRun } }, task.repoId);
    await this.emitDependencyRefreshUpdates(task.repoId, refreshedTasks, [task.taskId]);
    return nextRun;
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
        appendTimelineNote: 'Retrying evidence for the existing review.'
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
    const refreshedTasks = this.refreshDependencyStatesForRepo(nowIso);
    await this.persist();
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    await this.emitDependencyRefreshUpdates(updated.repoId, refreshedTasks, [run.taskId]);
    return updated;
  }

  async retryPreview(runId: string) {
    await this.ready;
    const run = await this.getRun(runId);
    const nowIso = new Date().toISOString();
    const updated = applyRunTransition(
      { ...run, endedAt: undefined },
      {
        status: 'WAITING_PREVIEW',
        previewUrl: undefined,
        previewStatus: 'DISCOVERING',
        evidenceStatus: 'NOT_STARTED',
        appendTimelineNote: 'Retrying preview discovery for the existing review.'
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
    const refreshedTasks = this.refreshDependencyStatesForRepo(nowIso);
    await this.persist();
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    await this.emitDependencyRefreshUpdates(updated.repoId, refreshedTasks, [run.taskId]);
    return updated;
  }

  async appendRunLogs(runId: string, logs: RunLogEntry[]) {
    await this.ready;
    const run = await this.getRun(runId);
    const events = logs.map((log) =>
      buildRunEvent(run, log.level === 'error' ? 'system' : 'sandbox', 'log.appended', log.message, {
        level: log.level,
        phase: log.phase ?? 'unknown'
      })
    );
    this.state = {
      ...this.state,
      logs: [...this.state.logs, ...logs],
      events: [...this.state.events, ...events]
    };
    await this.persist();
    await this.emit({ type: 'run.logs_appended', payload: { runId, logs } }, run.repoId);
    await this.emit({ type: 'run.events_appended', payload: { runId, events } }, run.repoId);
  }

  async appendRunEvents(runId: string, events: RunEvent[]) {
    await this.ready;
    const run = await this.getRun(runId);
    const normalizedEvents = events.map((event) => ({
      ...event,
      tenantId: run.tenantId,
      repoId: run.repoId,
      taskId: run.taskId,
      runId
    }));
    this.state = {
      ...this.state,
      events: [...this.state.events, ...normalizedEvents]
    };
    await this.persist();
    await this.emit({ type: 'run.events_appended', payload: { runId, events: normalizedEvents } }, run.repoId);
  }

  async upsertRunCommands(runId: string, commands: RunCommand[]) {
    await this.ready;
    const run = await this.getRun(runId);
    const normalizedCommands = commands.map((command) => ({
      ...command,
      tenantId: run.tenantId,
      runId
    }));
    const byId = new Map(this.state.commands.map((command) => [command.id, command]));
    for (const command of normalizedCommands) {
      byId.set(command.id, command);
    }

    const latestCommand = [...byId.values()]
      .filter((command) => command.runId === runId && command.status === 'running')
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

    const updatedRun = {
      ...run,
      currentCommandId: latestCommand?.id
    };

    this.state = {
      ...this.state,
      commands: [...byId.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updatedRun : candidate))
    };
    await this.persist();
    await this.emit({ type: 'run.updated', payload: { run: updatedRun } }, run.repoId);
    await this.emit({ type: 'run.commands_upserted', payload: { runId, commands: normalizedCommands } }, run.repoId);
  }

  async transitionRun(runId: string, patch: RunTransitionPatch): Promise<AgentRun> {
    await this.ready;
    const run = await this.getRun(runId);
    if (isTerminalRunStatus(run.status)) {
      return run;
    }
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
    const events = nextStatusChanged(run, updated, patch.appendTimelineNote)
      ? [
          buildRunEvent(
            updated,
            'workflow',
            'run.status_changed',
            `Run status changed from ${run.status} to ${updated.status}.`,
            { from: run.status, to: updated.status }
          )
        ]
      : [];

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === nextTask.taskId ? nextTask : candidate)),
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate)),
      events: [...this.state.events, ...events]
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(nowIso);
    await this.persist();
    const finalTask = this.state.tasks.find((candidate) => candidate.taskId === nextTask.taskId) ?? nextTask;
    await this.emit({ type: 'task.updated', payload: { task: finalTask } }, updated.repoId);
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    if (events.length) {
      await this.emit({ type: 'run.events_appended', payload: { runId, events } }, updated.repoId);
    }
    await this.emitDependencyRefreshUpdates(updated.repoId, refreshedTasks, [finalTask.taskId]);
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
      status: hasRunReview(updated) ? 'REVIEW' : 'FAILED',
      updatedAt: nowIso,
      runId
    };

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === nextTask.taskId ? nextTask : candidate)),
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate))
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(nowIso);
    await this.persist();
    const finalTask = this.state.tasks.find((candidate) => candidate.taskId === nextTask.taskId) ?? nextTask;
    await this.emit({ type: 'task.updated', payload: { task: finalTask } }, updated.repoId);
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    await this.emitDependencyRefreshUpdates(updated.repoId, refreshedTasks, [finalTask.taskId]);
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
    const updated = await this.transitionRun(runId, {
      artifactManifest: manifest,
      artifacts: [manifest.logs.key, manifest.before?.key, manifest.after?.key, manifest.trace?.key, manifest.video?.key].filter(Boolean) as string[]
    });
    await this.recordUsage(updated, [
      {
        category: 'r2_write_ops',
        quantity: 1,
        source: 'workflow',
        metadata: { object: 'artifact_manifest' }
      }
    ]);
    return updated;
  }

  async getRunArtifacts(runId: string) {
    const run = await this.getRun(runId);
    await this.recordUsage(run, [
      {
        category: 'artifact_download',
        quantity: 1,
        source: 'worker',
        metadata: { endpoint: '/api/runs/:runId/artifacts' }
      }
    ]);
    return run.artifactManifest;
  }

  async getRunLogs(runId: string, tail?: number) {
    await this.ready;
    const logs = this.state.logs.filter((entry) => entry.runId === runId);
    return tail ? logs.slice(-tail) : logs;
  }

  async getRunEvents(runId: string) {
    await this.ready;
    return this.state.events.filter((entry) => entry.runId === runId);
  }

  async getRunCommands(runId: string) {
    await this.ready;
    return this.state.commands.filter((entry) => entry.runId === runId);
  }

  async updateOperatorSession(runId: string, session?: OperatorSession) {
    await this.ready;
    const run = await this.getRun(runId);
    const normalizedSession = normalizeOperatorSession(
      session
        ? {
            ...session,
            tenantId: run.tenantId,
            runId,
            sandboxId: session.sandboxId || run.sandboxId || ''
          }
        : undefined
    );
    const updated = normalizeRunLlmState({
      ...run,
      operatorSession: normalizedSession,
      llmAdapter: normalizedSession?.llmAdapter ?? run.llmAdapter,
      llmSupportsResume: normalizedSession?.llmSupportsResume ?? run.llmSupportsResume,
      llmResumeCommand: normalizedSession?.llmResumeCommand ?? run.llmResumeCommand,
      llmSessionId: normalizedSession?.llmSessionId ?? run.llmSessionId,
      latestCodexResumeCommand: normalizedSession?.codexResumeCommand ?? run.latestCodexResumeCommand
    });
    this.state = {
      ...this.state,
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate))
    };
    await this.persist();
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    await this.emit({ type: 'run.operator_session_updated', payload: { runId, session: normalizedSession } }, updated.repoId);
    if (normalizedSession) {
      await this.recordUsage(updated, [
        {
          category: 'operator_session_ms',
          quantity: 1,
          source: 'operator',
          metadata: { event: 'operator_session_updated', state: normalizedSession.connectionState }
        }
      ]);
    }
    return updated;
  }

  async getTerminalBootstrap(runId: string): Promise<TerminalBootstrap> {
    await this.ready;
    const run = await this.getRun(runId);
    const sessionName = getOperatorSessionName(run);
    if (!run.sandboxId) {
      return {
        tenantId: run.tenantId,
        runId,
        repoId: run.repoId,
        taskId: run.taskId,
        sandboxId: '',
        sessionName,
        status: run.status,
        attachable: false,
        reason: 'sandbox_missing',
        cols: 120,
        rows: 32,
        llmSupportsResume: run.llmSupportsResume,
        llmResumeCommand: run.llmResumeCommand ?? run.latestCodexResumeCommand,
        codexResumeCommand: run.latestCodexResumeCommand
      };
    }

    if (isTerminalRunStatus(run.status)) {
      return {
        tenantId: run.tenantId,
        runId,
        repoId: run.repoId,
        taskId: run.taskId,
        sandboxId: run.sandboxId,
        sessionName,
        status: run.status,
        attachable: false,
        reason: 'run_not_active',
        cols: 120,
        rows: 32,
        session: run.operatorSession,
        llmSupportsResume: run.llmSupportsResume,
        llmResumeCommand: run.llmResumeCommand ?? run.latestCodexResumeCommand,
        codexResumeCommand: run.latestCodexResumeCommand
      };
    }

    return {
      tenantId: run.tenantId,
      runId,
      repoId: run.repoId,
      taskId: run.taskId,
      sandboxId: run.sandboxId,
      sessionName,
      status: run.status,
      attachable: true,
      wsPath: `/api/runs/${encodeURIComponent(runId)}/ws`,
      cols: 120,
      rows: 32,
      session: run.operatorSession,
      llmSupportsResume: run.llmSupportsResume,
      llmResumeCommand: run.llmResumeCommand ?? run.latestCodexResumeCommand,
      codexResumeCommand: run.latestCodexResumeCommand
    };
  }

  async takeOverRun(runId: string, actor = { actorId: 'same-session', actorLabel: 'Operator' }) {
    await this.ready;
    const run = await this.getRun(runId);
    if (!run.sandboxId) {
      throw notFound(`Sandbox for run ${runId} not found.`, { runId });
    }

    const now = new Date().toISOString();
    const sessionName = getOperatorSessionName(run);
    const session = run.operatorSession ?? {
      tenantId: run.tenantId,
      id: `${runId}:${sessionName}`,
      runId,
      sandboxId: run.sandboxId,
      sessionName,
      startedAt: now,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      connectionState: 'open' as const,
      takeoverState: 'observing' as const,
      llmAdapter: run.llmAdapter ?? 'codex',
      llmSupportsResume: run.llmSupportsResume,
      llmSessionId: run.llmSessionId,
      llmResumeCommand: run.llmResumeCommand ?? run.latestCodexResumeCommand,
      codexThreadId: undefined,
      codexResumeCommand: run.latestCodexResumeCommand
    };
    const nextSession: OperatorSession = normalizeOperatorSession({
      ...session,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      takeoverState: run.llmSupportsResume && run.llmResumeCommand ? 'resumable' : 'operator_control',
      connectionState: session.connectionState === 'failed' ? 'failed' : 'open'
    })!;

    const updated = normalizeRunLlmState({
      ...run,
      status: 'OPERATOR_CONTROLLED' as const,
      codexProcessId: undefined,
      currentCommandId: undefined,
      operatorSession: nextSession
    });
    const task = this.state.tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw notFound(`Task ${run.taskId} not found.`, { taskId: run.taskId, runId });
    }
    const nextTask: Task = {
      ...task,
      status: 'ACTIVE',
      runId,
      updatedAt: now
    };
    const events: RunEvent[] = [
      buildRunEvent(updated, 'operator', 'operator.takeover_started', 'Operator took control of the live sandbox session and stopped executor execution.', { sessionName: nextSession.sessionName })
    ];
    if (updated.latestCodexResumeCommand) {
      events.push(
        buildRunEvent(updated, 'system', 'codex.resume_available', 'Codex resume command is available for this run.', {
          command: updated.latestCodexResumeCommand
        })
      );
    }

    this.state = {
      ...this.state,
      tasks: this.state.tasks.map((candidate) => (candidate.taskId === nextTask.taskId ? nextTask : candidate)),
      runs: this.state.runs.map((candidate) => (candidate.runId === runId ? updated : candidate)),
      events: [...this.state.events, ...events]
    };
    const refreshedTasks = this.refreshDependencyStatesForRepo(now);
    await this.persist();
    const finalTask = this.state.tasks.find((candidate) => candidate.taskId === nextTask.taskId) ?? nextTask;
    await this.emit({ type: 'task.updated', payload: { task: finalTask } }, updated.repoId);
    await this.emit({ type: 'run.updated', payload: { run: updated } }, updated.repoId);
    await this.emit({ type: 'run.operator_session_updated', payload: { runId, session: nextSession } }, updated.repoId);
    await this.emit({ type: 'run.events_appended', payload: { runId, events } }, updated.repoId);
    await this.emitDependencyRefreshUpdates(updated.repoId, refreshedTasks, [finalTask.taskId]);
    await this.recordUsage(updated, [
      {
        category: 'operator_session_ms',
        quantity: 1,
        source: 'operator',
        metadata: { event: 'operator_takeover_started', sessionName: nextSession.sessionName }
      }
    ]);
    return updated;
  }

  async scheduleLocalRun(runId: string, mode: 'full_run' | 'evidence_only' | 'preview_only') {
    await this.ready;
    this.localJobs[runId] = mode;
    await this.persistLocalJobs();
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    await this.ready;
    const jobs = Object.entries(this.localJobs);
    if (!jobs.length) {
      return;
    }

    for (const [runId, mode] of jobs) {
      const run = this.state.runs.find((candidate) => candidate.runId === runId);
      if (!run) {
        delete this.localJobs[runId];
        continue;
      }

      delete this.localJobs[runId];
      await this.persistLocalJobs();
      try {
        await executeRunJob(this.env, { repoId: run.repoId, taskId: run.taskId, runId, mode }, sleepForAlarm);
      } catch (error) {
        console.error('Local alarm run execution failed', { runId, error });
      }
    }
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
    this.state = normalizeRepoBoardState(this.state);
    await this.ctx.storage.put(STORAGE_KEY, this.state);
  }

  private async persistLocalJobs() {
    await this.ctx.storage.put(LOCAL_JOBS_KEY, this.localJobs);
  }

  private cloneState(): RepoBoardState {
    return cloneRepoBoardState(this.state);
  }

  private async getRepo(repoId: string): Promise<Repo> {
    const board = this.env.BOARD_INDEX.getByName('agentboard');
    return board.getRepo(repoId);
  }

  private async recordUsage(
    run: Pick<AgentRun, 'tenantId' | 'repoId' | 'taskId' | 'runId'>,
    entries: Array<{
      category: import('../usage-ledger').UsageLedgerCategory;
      quantity: number;
      unit?: string;
      source: import('../usage-ledger').UsageLedgerSource;
      metadata?: Record<string, string | number | boolean>;
    }>
  ) {
    if (!entries.length) {
      return;
    }
    await writeUsageLedgerEntriesBestEffort(
      this.env,
      entries.map((entry) => ({
        tenantId: normalizeTenantId(run.tenantId),
        repoId: run.repoId,
        taskId: run.taskId,
        runId: run.runId,
        ...entry
      }))
    );
  }

  private async buildBoardPayload() {
    const tasks = [...this.state.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const runs = [...this.state.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const repoIds = [...new Set(tasks.map((task) => task.repoId).concat(runs.map((run) => run.repoId)))];
    const repos = await Promise.all(repoIds.map((repoId) => this.getRepo(repoId)));
    return {
      repos,
      tasks,
      runs,
      logs: [...this.state.logs],
      events: [...this.state.events],
      commands: [...this.state.commands]
    };
  }

  private refreshDependencyStatesForRepo(nowIso: string) {
    const result = refreshDependencyStates(this.state.tasks, this.state.runs, nowIso);
    if (!result.changedTaskIds.length) {
      return [];
    }

    this.state = {
      ...this.state,
      tasks: result.tasks
    };
    return result.tasks.filter((task) => result.changedTaskIds.includes(task.taskId));
  }

  private async emitDependencyRefreshUpdates(repoId: string, tasks: Task[], excludeTaskIds: string[] = []) {
    if (!tasks.length) {
      return;
    }

    const excluded = new Set(excludeTaskIds);
    for (const task of tasks) {
      if (task.repoId !== repoId) {
        continue;
      }
      if (excluded.has(task.taskId)) {
        continue;
      }
      await this.emit({ type: 'task.updated', payload: { task } }, repoId);
    }

    await this.autoStartRunnableDependencyTasks(repoId, tasks.map((task) => task.taskId));
  }

  private async autoStartRunnableDependencyTasks(repoId: string, candidateTaskIds: string[]) {
    if (!candidateTaskIds.length) {
      return;
    }

    const candidateIds = new Set(candidateTaskIds);
    const repo = await this.getRepo(repoId);
    const nowIso = new Date().toISOString();
    const tasksById = new Map(this.state.tasks.map((task) => [task.taskId, task]));
    const latestRunsByTaskId = buildLatestRunsByTaskId(this.state.runs);
    const runHistoryTaskIds = new Set(this.state.runs.map((run) => run.taskId));

    for (const task of this.state.tasks) {
      if (task.repoId !== repoId || !candidateIds.has(task.taskId) || !isRunnableDependencyAutoStartTask(task)) {
        continue;
      }
      if (task.runId || runHistoryTaskIds.has(task.taskId) || task.automationState?.autoStartedAt) {
        continue;
      }

      const hasActiveRun = this.state.runs.some((run) => run.taskId === task.taskId && !isTerminalRunStatus(run.status));
      if (hasActiveRun) {
        continue;
      }

      const resolvedSource = resolveRunSource({
        task,
        tasks: this.state.tasks,
        runs: this.state.runs,
        defaultBranch: repo.defaultBranch,
        resolvedAt: nowIso
      });
      if (!canAutoStartFromResolvedDependencySource(task, resolvedSource.dependencyContext.sourceMode, tasksById, latestRunsByTaskId)) {
        continue;
      }

      await this.startRun(task.taskId, { dependencyAutoStart: true });
    }
  }
}

function canAutoStartFromResolvedDependencySource(
  task: Task,
  sourceMode: NonNullable<AgentRun['dependencyContext']>['sourceMode'],
  tasksById: Map<string, Task>,
  latestRunsByTaskId: Map<string, AgentRun>
) {
  if (sourceMode === 'dependency_review_head') {
    return true;
  }

  if (sourceMode !== 'default_branch') {
    return false;
  }

  if (task.status !== 'INBOX' && task.status !== 'READY') {
    return false;
  }

  const dependencies = task.dependencies ?? [];
  if (!dependencies.length) {
    return false;
  }

  for (const dependency of dependencies) {
    const upstreamTask = tasksById.get(dependency.upstreamTaskId);
    const upstreamRun = latestRunsByTaskId.get(dependency.upstreamTaskId);
    if (!upstreamTask || !isDependencyMergedToDefaultBranch(upstreamTask, upstreamRun)) {
      return false;
    }
  }

  return true;
}

function isRunnableDependencyAutoStartTask(task: Task) {
  if (!task.dependencies?.length) {
    return false;
  }

  if (task.dependencyState?.blocked !== false) {
    return false;
  }

  if (!task.automationState?.autoStartEligible) {
    return false;
  }

  if (task.sourceRef?.trim()) {
    return false;
  }

  return task.status !== 'ACTIVE' && task.status !== 'REVIEW' && task.status !== 'DONE';
}

function validateDependenciesForTask(repoId: string, taskId: string, dependencies: Task['dependencies']) {
  if (!dependencies) {
    return;
  }

  for (const dependency of dependencies) {
    if (dependency.upstreamTaskId === taskId) {
      throw badRequest('Invalid dependencies: task cannot depend on itself.');
    }

    if (extractRepoIdFromTaskId(dependency.upstreamTaskId) !== repoId) {
      throw badRequest('Invalid dependencies: upstreamTaskId must reference a task in the same repo.');
    }
  }
}

function buildRunEvent(
  run: AgentRun,
  actorType: RunEvent['actorType'],
  eventType: RunEvent['eventType'],
  message: string,
  metadata?: Record<string, string | number | boolean>
): RunEvent {
  const at = new Date().toISOString();
  return {
    tenantId: run.tenantId,
    id: `${run.runId}_${eventType}_${at}_${Math.random().toString(36).slice(2, 8)}`,
    runId: run.runId,
    repoId: run.repoId,
    taskId: run.taskId,
    at,
    actorType,
    eventType,
    message,
    metadata
  };
}

function sleepForAlarm(_name: string, duration: number | `${number} ${string}`) {
  const milliseconds = typeof duration === 'number' ? duration : Number.parseInt(duration, 10) * 1000;
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function deriveTaskStatus(run: AgentRun, current: TaskStatus): TaskStatus {
  if (current === 'DONE' && run.status !== 'QUEUED' && run.status !== 'BOOTSTRAPPING' && run.status !== 'RUNNING_CODEX' && run.status !== 'OPERATOR_CONTROLLED' && run.status !== 'RUNNING_TESTS' && run.status !== 'PUSHING_BRANCH') {
    return 'DONE';
  }
  if (run.status === 'PR_OPEN' || run.status === 'WAITING_PREVIEW' || run.status === 'EVIDENCE_RUNNING' || run.status === 'DONE') {
    return 'REVIEW';
  }
  if (run.status === 'FAILED') {
    return hasRunReview(run) ? 'REVIEW' : 'FAILED';
  }
  if (run.status === 'QUEUED' || run.status === 'BOOTSTRAPPING' || run.status === 'RUNNING_CODEX' || run.status === 'OPERATOR_CONTROLLED' || run.status === 'RUNNING_TESTS' || run.status === 'PUSHING_BRANCH') {
    return 'ACTIVE';
  }
  return current;
}

function nextStatusChanged(previous: AgentRun, next: AgentRun, note?: string) {
  return previous.status !== next.status || Boolean(note);
}

function isTerminalRunStatus(status: AgentRun['status']) {
  return status === 'DONE' || status === 'FAILED';
}


function getOperatorSessionName(run: AgentRun) {
  if (!run.operatorSession?.sessionName || run.operatorSession.sessionName === 'operator') {
    return `operator-${run.runId}`;
  }

  return run.operatorSession.sessionName;
}

function cloneRepoBoardState(state: RepoBoardState): RepoBoardState {
  return {
    tasks: state.tasks.map((task) => ({
      ...task,
      dependencies: cloneTaskDependencies(task.dependencies),
      dependencyState: cloneTaskDependencyState(task.dependencyState),
      automationState: cloneTaskAutomationState(task.automationState),
      branchSource: cloneTaskBranchSource(task.branchSource),
      context: { ...task.context, links: task.context.links.map((link) => ({ ...link })) },
      uiMeta: normalizeTaskUiMeta(task.uiMeta ? { ...task.uiMeta } : undefined)
    })),
    runs: state.runs.map((run) => ({
      ...normalizeRunLlmState(normalizeRunReviewMetadata(run)),
      codexProcessId: run.codexProcessId,
      changeRequest: run.changeRequest ? { ...run.changeRequest } : undefined,
      dependencyContext: run.dependencyContext ? normalizeDependencyReviewMetadata({ ...run.dependencyContext }) : undefined,
      operatorSession: normalizeOperatorSession(run.operatorSession ? { ...run.operatorSession } : undefined),
      errors: run.errors.map((error) => ({ ...error })),
      timeline: run.timeline.map((entry) => ({ ...entry })),
      pendingEvents: run.pendingEvents.map((event) => ({ ...event })),
      executionSummary: run.executionSummary
        ? {
            ...run.executionSummary,
            previewResolution: run.executionSummary.previewResolution
              ? {
                  ...run.executionSummary.previewResolution,
                  diagnostics: run.executionSummary.previewResolution.diagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    metadata: diagnostic.metadata ? { ...diagnostic.metadata } : undefined
                  }))
                }
              : undefined
          }
        : undefined,
      artifacts: run.artifacts ? [...run.artifacts] : undefined,
      latestCodexResumeCommand: (run.llmAdapter ?? run.operatorSession?.llmAdapter ?? 'codex') === 'codex'
        ? (run.latestCodexResumeCommand ?? run.llmResumeCommand)
        : run.latestCodexResumeCommand,
      currentCommandId: run.currentCommandId,
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
    logs: state.logs.map((log) => ({ ...log, metadata: log.metadata ? { ...log.metadata } : undefined })),
    events: state.events.map((event) => ({ ...event, metadata: event.metadata ? { ...event.metadata } : undefined })),
    commands: state.commands.map((command) => ({ ...command }))
  };
}

function normalizeRepoBoardState(state?: Partial<RepoBoardState> | null): RepoBoardState {
  const normalizedTasks = (state?.tasks ?? []).map((task) => ({
    ...task,
    tenantId: normalizeTenantId(task.tenantId),
    branchSource: cloneTaskBranchSource(task.branchSource),
    uiMeta: normalizeTaskUiMeta(task.uiMeta)
  }));
  const taskTenantIds = new Map(normalizedTasks.map((task) => [task.taskId, task.tenantId]));
  const repoTenantIds = new Map(normalizedTasks.map((task) => [task.repoId, task.tenantId]));

  const normalizedRuns = (state?.runs ?? []).map((run) => {
    const tenantId = normalizeTenantId(run.tenantId ?? taskTenantIds.get(run.taskId) ?? repoTenantIds.get(run.repoId));
    const operatorSession = run.operatorSession
      ? normalizeOperatorSession({
          ...run.operatorSession,
          tenantId,
          runId: run.runId,
          sandboxId: run.operatorSession.sandboxId || run.sandboxId || ''
        })
      : undefined;
    return {
      ...normalizeRunLlmState(normalizeRunReviewMetadata({
        ...run,
        tenantId,
        operatorSession
      })),
      dependencyContext: run.dependencyContext ? normalizeDependencyReviewMetadata({ ...run.dependencyContext }) : undefined,
      executionSummary: run.executionSummary
        ? {
            ...run.executionSummary,
            previewResolution: run.executionSummary.previewResolution
              ? {
                  ...run.executionSummary.previewResolution,
                  diagnostics: (run.executionSummary.previewResolution.diagnostics ?? []).map((diagnostic) => ({
                    ...diagnostic,
                    metadata: diagnostic.metadata ? { ...diagnostic.metadata } : undefined
                  }))
                }
              : undefined
          }
        : undefined
    };
  });
  const runTenantIds = new Map(normalizedRuns.map((run) => [run.runId, run.tenantId]));
  for (const run of normalizedRuns) {
    if (!repoTenantIds.has(run.repoId)) {
      repoTenantIds.set(run.repoId, normalizeTenantId(run.tenantId));
    }
  }

  return {
    tasks: normalizedTasks,
    runs: normalizedRuns,
    logs: (state?.logs ?? [])
      .slice(-MAX_LOG_ENTRIES)
      .map((log) => ({ ...log, message: trimText(log.message, MAX_LOG_MESSAGE_CHARS) })),
    events: (state?.events ?? [])
      .slice(-MAX_EVENT_ENTRIES)
      .map((event) => ({
        ...event,
        tenantId: normalizeTenantId(
          event.tenantId
          ?? runTenantIds.get(event.runId)
          ?? taskTenantIds.get(event.taskId)
          ?? repoTenantIds.get(event.repoId)
        ),
        message: trimText(event.message, MAX_EVENT_MESSAGE_CHARS)
      })),
    commands: (state?.commands ?? [])
      .slice(-MAX_COMMAND_ENTRIES)
      .map((command) => ({
        ...command,
        tenantId: normalizeTenantId(command.tenantId ?? runTenantIds.get(command.runId) ?? DEFAULT_TENANT_ID),
        stdoutPreview: trimOptionalText(command.stdoutPreview, MAX_COMMAND_PREVIEW_CHARS),
        stderrPreview: trimOptionalText(command.stderrPreview, MAX_COMMAND_PREVIEW_CHARS)
      }))
  };
}

function trimText(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value;
}

function trimOptionalText(value: string | undefined, max: number) {
  return typeof value === 'string' ? trimText(value, max) : value;
}

function cloneTaskDependencies(dependencies: Task['dependencies']) {
  return dependencies?.map((dependency) => ({ ...dependency }));
}

function cloneTaskDependencyState(dependencyState: Task['dependencyState']) {
  return dependencyState
    ? {
        ...dependencyState,
        reasons: dependencyState.reasons.map((reason) => ({ ...reason }))
      }
    : undefined;
}

function cloneTaskAutomationState(automationState: Task['automationState']) {
  return automationState ? { ...automationState } : undefined;
}

function cloneTaskBranchSource(branchSource: Task['branchSource']) {
  return branchSource ? normalizeTaskBranchSourceReviewMetadata({ ...branchSource }) : undefined;
}
