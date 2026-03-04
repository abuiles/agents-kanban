import type {
  AcceptInviteInput,
  AgentBoardApi,
  AuthLoginInput,
  AuthSession,
  CreateInviteInput,
  CreateInviteResult,
  CreateRepoInput,
  CreateTaskInput,
  CreateUserApiTokenInput,
  CreateUserApiTokenResult,
  InviteRecord,
  RequestRunChangesInput,
  UpdateRepoInput,
  UpdateTaskInput,
  UserApiTokenRecord,
  UpsertScmCredentialInput
} from '../domain/api';
import type { AgentRun, BoardSnapshotV1, OperatorSession, Repo, RunCommand, RunEvent, RunLogEntry, ScmCredential, Task, TaskDetail, TerminalBootstrap } from '../domain/types';
import { getTaskDetail } from '../domain/selectors';
import { parseBoardSnapshot } from '../store/board-snapshot';
import { UiPreferencesStore } from '../store/ui-preferences-store';

const EMPTY_SNAPSHOT: BoardSnapshotV1 = {
  version: 1,
  repos: [],
  tasks: [],
  runs: [],
  logs: [],
  events: [],
  commands: [],
  ui: {
    selectedRepoId: 'all',
    seeded: false
  }
};

type BoardSyncResponse = Pick<BoardSnapshotV1, 'repos' | 'tasks' | 'runs' | 'logs' | 'events' | 'commands'>;

type BoardEvent =
  | { type: 'board.snapshot'; payload: BoardSyncResponse }
  | { type: 'repo.updated'; payload: { repo: Repo } }
  | { type: 'task.updated'; payload: { task: Task } }
  | { type: 'task.deleted'; payload: { taskId: string } }
  | { type: 'run.updated'; payload: { run: AgentRun } }
  | { type: 'run.logs_appended'; payload: { runId: string; logs: RunLogEntry[] } }
  | { type: 'run.events_appended'; payload: { runId: string; events: RunEvent[] } }
  | { type: 'run.commands_upserted'; payload: { runId: string; commands: RunCommand[] } }
  | { type: 'run.operator_session_updated'; payload: { runId: string; session?: OperatorSession } }
  | { type: 'server.error'; payload: { message: string } };

export class HttpAgentBoardApi implements AgentBoardApi {
  private snapshot: BoardSnapshotV1;
  private authSession?: AuthSession;
  private readonly listeners = new Set<() => void>();
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private reconnectDelayMs = 1_000;

  constructor(private readonly preferences = new UiPreferencesStore()) {
    this.snapshot = this.composeSnapshot(EMPTY_SNAPSHOT);
    this.preferences.subscribe(() => {
      this.snapshot = this.composeSnapshot(this.snapshot);
      this.emit();
    });

    void this.bootstrap();
  }

  async getAuthSession() {
    if (this.authSession) {
      return this.authSession;
    }
    try {
      this.authSession = await this.request<AuthSession>('/api/me');
      return this.authSession;
    } catch {
      this.authSession = undefined;
      return undefined;
    }
  }

  async login(input: AuthLoginInput): Promise<AuthSession> {
    await this.request('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
    const session = await this.request<AuthSession>('/api/me');
    this.authSession = session;
    await this.refresh();
    this.connectSocket();
    this.emit();
    return session;
  }

  async acceptInvite(input: AcceptInviteInput): Promise<AuthSession> {
    await this.request(`/api/invites/${encodeURIComponent(input.inviteId)}/accept`, {
      method: 'POST',
      body: JSON.stringify({
        token: input.token,
        password: input.password,
        displayName: input.displayName
      })
    });
    const session = await this.request<AuthSession>('/api/me');
    this.authSession = session;
    await this.refresh();
    this.connectSocket();
    this.emit();
    return session;
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout', { method: 'POST' });
    this.authSession = undefined;
    this.snapshot = this.composeSnapshot(EMPTY_SNAPSHOT);
    this.socket?.close();
    this.socket = undefined;
    this.emit();
  }

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
    return this.request<CreateInviteResult>('/api/invites', { method: 'POST', body: JSON.stringify(input) });
  }

  async listInvites(): Promise<InviteRecord[]> {
    return this.request<InviteRecord[]>('/api/invites');
  }

  async createApiToken(input: CreateUserApiTokenInput): Promise<CreateUserApiTokenResult> {
    return this.request<CreateUserApiTokenResult>('/api/me/api-tokens', { method: 'POST', body: JSON.stringify(input) });
  }

  async listApiTokens(): Promise<UserApiTokenRecord[]> {
    return this.request<UserApiTokenRecord[]>('/api/me/api-tokens');
  }

  async revokeApiToken(tokenId: string): Promise<void> {
    await this.request(`/api/me/api-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return this.snapshot;
  }

  async createRepo(input: CreateRepoInput) {
    const repo = await this.request<Repo>('/api/repos', { method: 'POST', body: JSON.stringify(input) });
    await this.refresh();
    return repo;
  }

  async listRepos() {
    return this.snapshot.repos;
  }

  async updateRepo(repoId: string, patch: UpdateRepoInput) {
    const repo = await this.request<Repo>(`/api/repos/${encodeURIComponent(repoId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await this.refresh();
    return repo;
  }

  async listScmCredentials() {
    return this.request<ScmCredential[]>('/api/scm/credentials');
  }

  async getScmCredential(scmProvider: UpsertScmCredentialInput['scmProvider'], host: string) {
    return this.request<ScmCredential>(`/api/scm/credentials/${encodeURIComponent(scmProvider)}/${encodeURIComponent(host)}`).catch((error: Error) => {
      if (error.message.includes('not found')) {
        return undefined;
      }
      throw error;
    });
  }

  async upsertScmCredential(input: UpsertScmCredentialInput) {
    return this.request<ScmCredential>('/api/scm/credentials', { method: 'POST', body: JSON.stringify(input) });
  }

  async createTask(input: CreateTaskInput) {
    const task = await this.request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(input) });
    await this.refresh();
    return task;
  }

  async listTasks(filter?: { repoId?: string; tags?: string[] }) {
    const normalizedTags = (filter?.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
    const filteredByRepo = (!filter?.repoId || filter.repoId === 'all')
      ? this.snapshot.tasks
      : this.snapshot.tasks.filter((task) => task.repoId === filter.repoId);
    if (!normalizedTags.length) {
      return filteredByRepo;
    }
    return filteredByRepo.filter((task) => normalizedTags.every((tag) => task.tags?.includes(tag)));
  }

  async getTask(taskId: string) {
    const detail = await this.request<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
    this.mergeTaskDetail(detail);
    return detail;
  }

  async updateTask(taskId: string, patch: UpdateTaskInput) {
    const task = await this.request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await this.refresh();
    return task;
  }

  async startRun(taskId: string) {
    const run = await this.request<AgentRun>(`/api/tasks/${encodeURIComponent(taskId)}/run`, { method: 'POST' });
    await this.refresh();
    return run;
  }

  async getRun(runId: string) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}`);
    this.mergeRun(run);
    return run;
  }

  async retryRun(runId: string) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' });
    await this.refresh();
    return run;
  }

  async rerunReview(runId: string) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}/review`, { method: 'POST' });
    await this.refresh();
    return run;
  }

  async requestRunChanges(runId: string, input: RequestRunChangesInput) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}/request-changes`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
    await this.refresh();
    return run;
  }

  async retryPreview(runId: string) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}/preview`, { method: 'POST' });
    await this.refresh();
    return run;
  }

  async retryEvidence(runId: string) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}/evidence`, { method: 'POST' });
    await this.refresh();
    return run;
  }

  async takeOverRun(runId: string) {
    const run = await this.request<AgentRun>(`/api/runs/${encodeURIComponent(runId)}/takeover`, { method: 'POST' });
    await this.refresh();
    return run;
  }

  async getRunLogs(runId: string, options?: { tail?: number }) {
    const search = options?.tail ? `?tail=${options.tail}` : '';
    const logs = await this.request<RunLogEntry[]>(`/api/runs/${encodeURIComponent(runId)}/logs${search}`);
    this.snapshot = this.composeSnapshot({
      ...this.snapshot,
      logs: dedupeLogs([...this.snapshot.logs.filter((entry) => entry.runId !== runId), ...logs])
    });
    this.emit();
    return logs;
  }

  async getRunEvents(runId: string) {
    const events = await this.request<RunEvent[]>(`/api/runs/${encodeURIComponent(runId)}/events`);
    this.snapshot = this.composeSnapshot({
      ...this.snapshot,
      events: dedupeById([...this.snapshot.events.filter((entry) => entry.runId !== runId), ...events], 'id')
    });
    this.emit();
    return events;
  }

  async getRunCommands(runId: string) {
    const commands = await this.request<RunCommand[]>(`/api/runs/${encodeURIComponent(runId)}/commands`);
    this.snapshot = this.composeSnapshot({
      ...this.snapshot,
      commands: dedupeById([...this.snapshot.commands.filter((entry) => entry.runId !== runId), ...commands], 'id')
    });
    this.emit();
    return commands;
  }

  async getTerminalBootstrap(runId: string) {
    return this.request<TerminalBootstrap>(`/api/runs/${encodeURIComponent(runId)}/terminal`);
  }

  exportState() {
    return JSON.stringify(this.snapshot, null, 2);
  }

  async importState(serialized: string) {
    const snapshot = parseBoardSnapshot(serialized);
    await this.request('/api/debug/import', { method: 'POST', body: JSON.stringify(snapshot) });
    await this.refresh();
  }

  getSelectedRepoId() {
    return this.preferences.getSnapshot().selectedRepoId;
  }

  async setSelectedRepoId(repoId: string | 'all') {
    this.preferences.setSelectedRepoId(repoId);
  }

  getSelectedTaskId() {
    return this.preferences.getSnapshot().selectedTaskId;
  }

  async setSelectedTaskId(taskId?: string) {
    this.preferences.setSelectedTaskId(taskId);
  }

  private async refresh() {
    const data = await this.request<BoardSyncResponse>('/api/board?repoId=all');
    this.snapshot = this.composeSnapshot({ ...EMPTY_SNAPSHOT, ...data });
    this.emit();
  }

  private async bootstrap() {
    const session = await this.getAuthSession();
    if (!session) {
      this.emit();
      return;
    }
    await this.refresh();
    this.connectSocket();
  }

  private composeSnapshot(snapshot: BoardSnapshotV1): BoardSnapshotV1 {
    const ui = this.preferences.getSnapshot();
    return {
      ...snapshot,
      ui: {
        selectedRepoId: ui.selectedRepoId,
        selectedTaskId: ui.selectedTaskId,
        seeded: false
      }
    };
  }

  private connectSocket() {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${window.location.host}/api/board/ws?repoId=all`);
    this.socket.addEventListener('message', (event) => {
      try {
        this.handleSocketEvent(JSON.parse(event.data) as BoardEvent);
      } catch (error) {
        console.error('Invalid board websocket event', error);
      }
    });
    this.socket.addEventListener('close', () => {
      this.socket = undefined;
      this.scheduleReconnect();
    });
    this.socket.addEventListener('error', () => {
      this.socket?.close();
    });
  }

  private handleSocketEvent(event: BoardEvent) {
    switch (event.type) {
      case 'board.snapshot':
        this.snapshot = this.composeSnapshot({ ...EMPTY_SNAPSHOT, ...event.payload });
        this.emit();
        return;
      case 'repo.updated':
        this.snapshot = this.composeSnapshot({
          ...this.snapshot,
          repos: upsertById(this.snapshot.repos, event.payload.repo, 'repoId')
        });
        this.emit();
        return;
      case 'task.updated':
        this.mergeTask(event.payload.task);
        return;
      case 'task.deleted':
        this.snapshot = this.composeSnapshot({
          ...this.snapshot,
          tasks: this.snapshot.tasks.filter((task) => task.taskId !== event.payload.taskId),
          runs: this.snapshot.runs.filter((run) => run.taskId !== event.payload.taskId)
        });
        this.emit();
        return;
      case 'run.updated':
        this.mergeRun(event.payload.run);
        return;
      case 'run.logs_appended':
        this.snapshot = this.composeSnapshot({
          ...this.snapshot,
          logs: dedupeLogs([...this.snapshot.logs, ...event.payload.logs])
        });
        this.emit();
        return;
      case 'run.events_appended':
        this.snapshot = this.composeSnapshot({
          ...this.snapshot,
          events: dedupeById([...this.snapshot.events, ...event.payload.events], 'id')
        });
        this.emit();
        return;
      case 'run.commands_upserted':
        this.snapshot = this.composeSnapshot({
          ...this.snapshot,
          commands: dedupeById([...this.snapshot.commands, ...event.payload.commands], 'id')
        });
        this.emit();
        return;
      case 'run.operator_session_updated':
        this.snapshot = this.composeSnapshot({
          ...this.snapshot,
          runs: this.snapshot.runs.map((run) => (run.runId === event.payload.runId ? { ...run, operatorSession: event.payload.session } : run))
        });
        this.emit();
        return;
      case 'server.error':
        console.error('Board websocket server error', event.payload.message);
        return;
    }
  }

  private mergeTask(task: Task) {
    this.snapshot = this.composeSnapshot({
      ...this.snapshot,
      tasks: upsertById(this.snapshot.tasks, task, 'taskId')
    });
    this.emit();
  }

  private mergeRun(run: AgentRun) {
    this.snapshot = this.composeSnapshot({
      ...this.snapshot,
      runs: upsertById(this.snapshot.runs, run, 'runId')
    });
    this.emit();
  }

  private mergeTaskDetail(detail: TaskDetail) {
    this.snapshot = this.composeSnapshot({
      ...this.snapshot,
      repos: upsertById(this.snapshot.repos, detail.repo, 'repoId'),
      tasks: upsertById(this.snapshot.tasks, detail.task, 'taskId'),
      runs: mergeCollection(this.snapshot.runs, detail.runs, 'runId')
    });
    this.emit();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || typeof window === 'undefined') {
      return;
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 8_000);
      void this.refresh();
      this.connectSocket();
    }, this.reconnectDelayMs);
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async request<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await fetch(input, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
      throw new Error(payload?.message ?? `Request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

function upsertById<T extends Record<string, unknown>, K extends keyof T>(items: T[], item: T, key: K) {
  const exists = items.some((candidate) => candidate[key] === item[key]);
  const next = exists ? items.map((candidate) => (candidate[key] === item[key] ? item : candidate)) : [item, ...items];
  return next;
}

function mergeCollection<T extends Record<string, unknown>, K extends keyof T>(items: T[], nextItems: T[], key: K) {
  return nextItems.reduce((acc, item) => upsertById(acc, item, key), items);
}

function dedupeLogs(logs: RunLogEntry[]) {
  const seen = new Set<string>();
  return logs.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

function dedupeById<T extends { id: string }>(items: T[], key: 'id') {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = item[key];
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}
