import type {
  AgentBoardApi,
  AuthLoginInput,
  AuthSession,
  AuthSignupInput,
  CreateRepoInput,
  CreateTaskInput,
  RequestRunChangesInput,
  UpdateRepoInput,
  UpdateTaskInput,
  UpsertScmCredentialInput
} from '../domain/api';
import type { AgentRun, Repo, RunCommand, RunEvent, RunLogEntry, ScmCredential, Task, TaskDetail, Tenant, TenantMember, TerminalBootstrap, User } from '../domain/types';
import { getTaskDetail, getTasksForRepo } from '../domain/selectors';
import { LocalBoardStore } from '../store/local-board-store';
import { parseImportedBoard } from '../store/import-export';
import { RunSimulator } from './run-simulator';
import { normalizeOperatorSession, normalizeRunLlmState, normalizeTaskUiMeta } from '../../shared/llm';
import { normalizeCredentialHost, normalizeRepo } from '../../shared/scm';

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export class LocalAgentBoardApi implements AgentBoardApi {
  private readonly simulator: RunSimulator;
  private readonly scmCredentials = new Map<string, ScmCredential & { token: string }>();
  private authSession?: AuthSession;

  constructor(private readonly store: LocalBoardStore) {
    this.simulator = new RunSimulator(store);
    this.simulator.resumeAll();
    const now = nowIso();
    const user: User = { id: 'user_local', email: 'local@example.com', displayName: 'Local User', createdAt: now, updatedAt: now };
    const tenant: Tenant = {
      id: 'tenant_local',
      slug: 'local',
      name: 'Local Tenant',
      status: 'active',
      createdByUserId: user.id,
      defaultSeatLimit: 10,
      seatLimit: 10,
      createdAt: now,
      updatedAt: now
    };
    const membership: TenantMember = {
      id: `${tenant.id}:${user.id}`,
      tenantId: tenant.id,
      userId: user.id,
      role: 'owner',
      seatState: 'active',
      createdAt: now,
      updatedAt: now
    };
    this.authSession = { user, tenants: [tenant], memberships: [membership], activeTenantId: tenant.id };
  }

  subscribe(listener: () => void) {
    return this.store.subscribe(listener);
  }

  getSnapshot() {
    return this.store.getSnapshot();
  }

  async getAuthSession() {
    return this.authSession;
  }

  async login(_input: AuthLoginInput): Promise<AuthSession> {
    if (!this.authSession) {
      throw new Error('No local auth session available.');
    }
    return this.authSession;
  }

  async signup(_input: AuthSignupInput): Promise<AuthSession> {
    if (!this.authSession) {
      throw new Error('No local auth session available.');
    }
    return this.authSession;
  }

  async logout(): Promise<void> {
    this.authSession = undefined;
  }

  async setActiveTenant(tenantId: string): Promise<AuthSession> {
    if (!this.authSession) {
      throw new Error('No local auth session available.');
    }
    this.authSession = { ...this.authSession, activeTenantId: tenantId };
    return this.authSession;
  }

  async createRepo(input: CreateRepoInput): Promise<Repo> {
    const timestamp = nowIso();
    const repo: Repo = normalizeRepo({
      repoId: randomId('repo'),
      slug: input.slug ?? input.projectPath ?? '',
      scmProvider: input.scmProvider,
      scmBaseUrl: input.scmBaseUrl,
      projectPath: input.projectPath,
      llmAdapter: input.llmAdapter,
      llmProfileId: input.llmProfileId,
      llmAuthBundleR2Key: input.llmAuthBundleR2Key ?? input.codexAuthBundleR2Key,
      defaultBranch: input.defaultBranch ?? 'main',
      baselineUrl: input.baselineUrl,
      enabled: input.enabled ?? true,
      previewMode: input.previewMode ?? 'auto',
      evidenceMode: input.evidenceMode ?? 'auto',
      previewAdapter: input.previewAdapter,
      previewConfig: input.previewConfig,
      previewProvider: input.previewProvider,
      previewCheckName: input.previewCheckName,
      codexAuthBundleR2Key: input.codexAuthBundleR2Key ?? input.llmAuthBundleR2Key,
      createdAt: timestamp,
      updatedAt: timestamp
    });

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

        updatedRepo = normalizeRepo({
          ...repo,
          ...patch,
          slug: patch.slug ?? patch.projectPath ?? repo.slug,
          projectPath: patch.projectPath ?? patch.slug ?? repo.projectPath,
          updatedAt: nowIso()
        });
        return updatedRepo;
      })
    }));

    if (!updatedRepo) {
      throw new Error(`Repo ${repoId} not found.`);
    }

    return updatedRepo;
  }

  async listScmCredentials(): Promise<ScmCredential[]> {
    return [...this.scmCredentials.values()]
      .sort((left, right) => left.credentialId.localeCompare(right.credentialId))
      .map(({ token: _token, ...credential }) => credential);
  }

  async getScmCredential(scmProvider: UpsertScmCredentialInput['scmProvider'], host: string): Promise<ScmCredential | undefined> {
    const credential = this.scmCredentials.get(`${scmProvider}:${normalizeCredentialHost(host)}`);
    if (!credential) {
      return undefined;
    }

    const { token: _token, ...publicCredential } = credential;
    return publicCredential;
  }

  async upsertScmCredential(input: UpsertScmCredentialInput): Promise<ScmCredential> {
    const now = nowIso();
    const key = `${input.scmProvider}:${normalizeCredentialHost(input.host)}`;
    const existing = this.scmCredentials.get(key);
    const credential = {
      credentialId: key,
      scmProvider: input.scmProvider,
      host: normalizeCredentialHost(input.host),
      label: input.label,
      hasSecret: true,
      token: input.token,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.scmCredentials.set(key, credential);
    const { token: _token, ...publicCredential } = credential;
    return publicCredential;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const timestamp = nowIso();
    const task: Task = {
      taskId: randomId('task'),
      repoId: input.repoId,
      title: input.title,
      description: input.description,
      sourceRef: input.sourceRef,
      dependencies: input.dependencies,
      dependencyState: input.dependencyState,
      automationState: input.automationState,
      branchSource: input.branchSource,
      taskPrompt: input.taskPrompt,
      acceptanceCriteria: input.acceptanceCriteria,
      context: input.context,
      baselineUrlOverride: input.baselineUrlOverride,
      status: input.status ?? 'INBOX',
      createdAt: timestamp,
      updatedAt: timestamp,
      uiMeta: normalizeTaskUiMeta({
        simulationProfile: input.simulationProfile ?? 'happy_path',
        llmAdapter: input.llmAdapter,
        llmModel: input.llmModel,
        llmReasoningEffort: input.llmReasoningEffort,
        codexModel: input.codexModel,
        codexReasoningEffort: input.codexReasoningEffort
      })
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
          sourceRef: patch.sourceRef ?? task.sourceRef,
          context: patch.context ?? task.context,
          acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria,
          uiMeta: normalizeTaskUiMeta({
            simulationProfile: patch.simulationProfile ?? task.uiMeta?.simulationProfile ?? 'happy_path',
            llmAdapter: patch.llmAdapter ?? task.uiMeta?.llmAdapter,
            llmModel: patch.llmModel ?? task.uiMeta?.llmModel,
            llmReasoningEffort: patch.llmReasoningEffort ?? task.uiMeta?.llmReasoningEffort,
            codexModel: patch.codexModel ?? task.uiMeta?.codexModel,
            codexReasoningEffort: patch.codexReasoningEffort ?? task.uiMeta?.codexReasoningEffort
          }),
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

  async requestRunChanges(runId: string, input: RequestRunChangesInput): Promise<AgentRun> {
    const run = await this.getRun(runId);
    const task = this.store.getSnapshot().tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw new Error(`Task ${run.taskId} not found.`);
    }

    return this.simulator.createRun(
      {
        ...task,
        status: 'ACTIVE',
        updatedAt: nowIso()
      },
      {
        branchName: run.branchName,
        prUrl: run.prUrl,
        prNumber: run.prNumber,
        baseRunId: run.runId,
        changeRequest: { prompt: input.prompt, requestedAt: nowIso() }
      }
    );
  }

  async retryPreview(runId: string): Promise<AgentRun> {
    return this.simulator.retryPreview(runId);
  }

  async retryEvidence(runId: string): Promise<AgentRun> {
    return this.simulator.retryEvidence(runId);
  }

  async takeOverRun(runId: string): Promise<AgentRun> {
    let updatedRun: AgentRun | undefined;
    const updatedAt = nowIso();
    this.store.update((snapshot) => ({
      ...snapshot,
      tasks: snapshot.tasks.map((task) =>
        task.taskId === snapshot.runs.find((run) => run.runId === runId)?.taskId
          ? { ...task, status: 'ACTIVE', updatedAt }
          : task
      ),
      runs: snapshot.runs.map((run) => {
        if (run.runId !== runId) {
          return run;
        }

        updatedRun = normalizeRunLlmState({
          ...run,
          status: 'OPERATOR_CONTROLLED',
          codexProcessId: undefined,
          currentCommandId: undefined,
          operatorSession: run.operatorSession
            ? normalizeOperatorSession({
                ...run.operatorSession,
                takeoverState: run.llmSupportsResume && run.llmResumeCommand ? 'resumable' : 'operator_control',
                connectionState: 'open'
              })
            : normalizeOperatorSession({
                id: `session_${runId}`,
                runId,
                sandboxId: run.sandboxId ?? `mock-${runId}`,
                sessionName: 'operator',
                startedAt: nowIso(),
                actorId: 'same-session',
                actorLabel: 'Operator',
                connectionState: 'open',
                takeoverState: run.llmSupportsResume && run.llmResumeCommand ? 'resumable' : 'operator_control',
                llmAdapter: run.llmAdapter ?? 'codex',
                llmSupportsResume: run.llmSupportsResume,
                llmSessionId: run.llmSessionId,
                llmResumeCommand: run.llmResumeCommand ?? run.latestCodexResumeCommand,
                codexResumeCommand: run.latestCodexResumeCommand
              })
        });
        return updatedRun;
      })
    }));

    if (!updatedRun) {
      throw new Error(`Run ${runId} not found.`);
    }

    return updatedRun;
  }

  async getRunLogs(runId: string, options?: { tail?: number }): Promise<RunLogEntry[]> {
    const logs = this.store.getSnapshot().logs.filter((log) => log.runId === runId);
    return options?.tail ? logs.slice(-options.tail) : logs;
  }

  async getRunEvents(runId: string): Promise<RunEvent[]> {
    return this.store.getSnapshot().events.filter((event) => event.runId === runId);
  }

  async getRunCommands(runId: string): Promise<RunCommand[]> {
    return this.store.getSnapshot().commands.filter((command) => command.runId === runId);
  }

  async getTerminalBootstrap(runId: string): Promise<TerminalBootstrap> {
    const run = await this.getRun(runId);
    if (!run.sandboxId || ['DONE', 'FAILED'].includes(run.status)) {
      return {
        runId,
        repoId: run.repoId,
        taskId: run.taskId,
        sandboxId: run.sandboxId ?? '',
        sessionName: 'operator',
        status: run.status,
        attachable: false,
        reason: !run.sandboxId ? 'sandbox_missing' : 'run_not_active',
        cols: 120,
        rows: 32,
        session: run.operatorSession,
        llmSupportsResume: run.llmSupportsResume,
        llmResumeCommand: run.llmResumeCommand ?? run.latestCodexResumeCommand,
        codexResumeCommand: run.latestCodexResumeCommand
      };
    }

    return {
      runId,
      repoId: run.repoId,
      taskId: run.taskId,
      sandboxId: run.sandboxId,
      sessionName: 'operator',
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
