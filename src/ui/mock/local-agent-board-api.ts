import type {
  AcceptInviteInput,
  AgentBoardApi,
  AuthLoginInput,
  AuthSession,
  CreateInviteInput,
  CreateInviteResult,
  CreateRepoInput,
  RepoSentinelActionResult,
  RepoSentinelConfigInput,
  RepoSentinelStartInput,
  RepoSentinelStatus,
  CreateTaskInput,
  CreateUserApiTokenInput,
  CreateUserApiTokenResult,
  InviteRecord,
  RequestRunChangesInput,
  RetryRunInput,
  UpdateRepoInput,
  UpdateTaskInput,
  UserApiTokenRecord,
  UpsertScmCredentialInput
} from '../domain/api';
import type { AgentRun, Repo, RunCheckpoint, RunCommand, RunEvent, RunLogEntry, ScmCredential, Task, TaskDetail, TenantMember, TerminalBootstrap, User } from '../domain/types';
import { getTaskDetail, getTasksForRepo } from '../domain/selectors';
import { LocalBoardStore } from '../store/local-board-store';
import { parseImportedBoard } from '../store/import-export';
import { RunSimulator } from './run-simulator';
import { normalizeOperatorSession, normalizeRunLlmState, normalizeTaskUiMeta } from '../../shared/llm';
import { DEFAULT_REPO_CHECKPOINT_CONFIG, normalizeRepoCheckpointConfig } from '../../shared/checkpoint';
import { normalizeCredentialHost, normalizeRepo } from '../../shared/scm';
import { DEFAULT_REPO_SENTINEL_CONFIG, normalizeRepoSentinelConfig } from '../../shared/sentinel';

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export class LocalAgentBoardApi implements AgentBoardApi {
  private readonly simulator: RunSimulator;
  private readonly scmCredentials = new Map<string, ScmCredential & { token: string }>();
  private readonly invites = new Map<string, InviteRecord & { token: string }>();
  private readonly userApiTokens = new Map<string, UserApiTokenRecord & { token: string }>();
  private readonly repoSentinelRuns = new Map<string, NonNullable<RepoSentinelStatus['run']>>();
  private readonly repoSentinelEvents = new Map<string, RepoSentinelStatus['events']>();
  private authSession?: AuthSession;

  private createLocalAuthSession(userOverride?: Partial<User> & Pick<User, 'id' | 'email'>, role: TenantMember['role'] = 'owner'): AuthSession {
    const now = nowIso();
    const user: User = {
      id: userOverride?.id ?? 'user_local',
      email: userOverride?.email ?? 'local@example.com',
      displayName: userOverride?.displayName ?? 'Local User',
      createdAt: userOverride?.createdAt ?? now,
      updatedAt: now
    };
    const membership: TenantMember = {
      id: `tenant_local:${user.id}`,
      tenantId: 'tenant_local',
      userId: user.id,
      role,
      seatState: 'active',
      createdAt: now,
      updatedAt: now
    };
    return { user, memberships: [membership] };
  }

  constructor(private readonly store: LocalBoardStore) {
    this.simulator = new RunSimulator(store);
    this.simulator.resumeAll();
    this.authSession = this.createLocalAuthSession();
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
      this.authSession = this.createLocalAuthSession();
    }
    return this.authSession;
  }

  async logout(): Promise<void> {
    this.authSession = undefined;
  }

  async acceptInvite(input: AcceptInviteInput): Promise<AuthSession> {
    const invite = this.invites.get(input.inviteId);
    if (!invite || invite.status !== 'pending') {
      throw new Error(`Invite ${input.inviteId} not found.`);
    }
    if (invite.token !== input.token) {
      throw new Error('Invalid invite token.');
    }
    const now = nowIso();
    const acceptedByUserId = `user_${Math.random().toString(36).slice(2, 10)}`;
    const acceptedInvite: InviteRecord & { token: string } = {
      ...invite,
      status: 'accepted',
      acceptedByUserId,
      acceptedAt: now,
      updatedAt: now
    };
    this.invites.set(invite.id, acceptedInvite);
    this.authSession = this.createLocalAuthSession({
      id: acceptedByUserId,
      email: acceptedInvite.email,
      displayName: input.displayName || acceptedInvite.email.split('@')[0]
    }, acceptedInvite.role);
    return this.authSession;
  }

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
    const actor = this.authSession?.user;
    const actorMembership = this.authSession?.memberships.find((membership) => membership.userId === actor?.id);
    if (!actor || actorMembership?.role !== 'owner') {
      throw new Error('Only owner users may create invites.');
    }
    const existing = [...this.invites.values()].find((invite) => invite.email === input.email.trim().toLowerCase() && invite.status === 'pending');
    if (existing) {
      throw new Error(`Pending invite for ${input.email} already exists.`);
    }
    const now = nowIso();
    const inviteId = randomId('invite');
    const token = randomId('invite_token');
    const invite: InviteRecord & { token: string } = {
      id: inviteId,
      tenantId: 'tenant_local',
      email: input.email.trim().toLowerCase(),
      role: input.role === 'owner' ? 'owner' : 'member',
      status: 'pending',
      createdByUserId: actor.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
      createdAt: now,
      updatedAt: now,
      token
    };
    this.invites.set(inviteId, invite);
    const { token: _token, ...inviteRecord } = invite;
    return {
      invite: inviteRecord,
      token,
      seatSummary: {
        tenantId: 'tenant_local',
        seatLimit: 10,
        seatsUsed: 1,
        seatsAvailable: 9
      }
    };
  }

  async listInvites(): Promise<InviteRecord[]> {
    return [...this.invites.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ token: _token, ...invite }) => invite);
  }

  async createApiToken(input: CreateUserApiTokenInput): Promise<CreateUserApiTokenResult> {
    if (!this.authSession) {
      throw new Error('No local auth session available.');
    }
    const now = nowIso();
    const tokenRecord: UserApiTokenRecord & { token: string } = {
      id: randomId('pat'),
      userId: this.authSession.user.id,
      name: input.name.trim(),
      scopes: input.scopes ?? [],
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      token: randomId('pat_token')
    };
    this.userApiTokens.set(tokenRecord.id, tokenRecord);
    const { token, ...publicRecord } = tokenRecord;
    return { tokenRecord: publicRecord, token };
  }

  async listApiTokens(): Promise<UserApiTokenRecord[]> {
    if (!this.authSession) {
      throw new Error('No local auth session available.');
    }
    const userId = this.authSession.user.id;
    return [...this.userApiTokens.values()]
      .filter((token) => token.userId === userId && !token.revokedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ token: _token, ...record }) => record);
  }

  async revokeApiToken(tokenId: string): Promise<void> {
    if (!this.authSession) {
      throw new Error('No local auth session available.');
    }
    const token = this.userApiTokens.get(tokenId);
    if (!token || token.userId !== this.authSession.user.id) {
      throw new Error(`API token ${tokenId} not found.`);
    }
    this.userApiTokens.set(tokenId, { ...token, revokedAt: nowIso(), updatedAt: nowIso() });
  }

  async createRepo(input: CreateRepoInput): Promise<Repo> {
    const timestamp = nowIso();
    const normalizedAutoReview = {
      enabled: input.autoReview?.enabled ?? false,
      provider: input.autoReview?.provider ?? 'gitlab',
      postInline: input.autoReview?.postInline ?? false,
      ...(input.autoReview?.prompt ? { prompt: input.autoReview.prompt.trim() } : {})
    };
    const normalizedSentinelConfig = normalizeRepoSentinelConfig({
      sentinelConfig: {
        ...DEFAULT_REPO_SENTINEL_CONFIG,
        ...input.sentinelConfig,
        reviewGate: {
          ...DEFAULT_REPO_SENTINEL_CONFIG.reviewGate,
          ...(input.sentinelConfig?.reviewGate ?? {})
        },
        mergePolicy: {
          ...DEFAULT_REPO_SENTINEL_CONFIG.mergePolicy,
          ...(input.sentinelConfig?.mergePolicy ?? {})
        },
        conflictPolicy: {
          ...DEFAULT_REPO_SENTINEL_CONFIG.conflictPolicy,
          ...(input.sentinelConfig?.conflictPolicy ?? {})
        }
      }
    }).sentinelConfig;
    const repo: Repo = normalizeRepo({
      repoId: randomId('repo'),
      slug: input.slug ?? input.projectPath ?? '',
      scmProvider: input.scmProvider,
      scmBaseUrl: input.scmBaseUrl,
      autoReview: normalizedAutoReview,
      sentinelConfig: normalizedSentinelConfig,
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
      commitConfig: input.commitConfig,
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

        const hasAutoReviewPatch = Object.prototype.hasOwnProperty.call(patch, 'autoReview');
        const hasSentinelConfigPatch = Object.prototype.hasOwnProperty.call(patch, 'sentinelConfig');
        const hasCheckpointConfigPatch = Object.prototype.hasOwnProperty.call(patch, 'checkpointConfig');
        const mergedAutoReview = hasAutoReviewPatch
          ? {
              ...(repo.autoReview ?? { enabled: false, provider: 'gitlab', postInline: false }),
              ...patch.autoReview
            }
          : repo.autoReview;
        const mergedSentinelConfig = hasSentinelConfigPatch
          ? {
              ...(repo.sentinelConfig ?? {}),
              ...patch.sentinelConfig,
              reviewGate: {
                ...(repo.sentinelConfig?.reviewGate ?? {}),
                ...(patch.sentinelConfig?.reviewGate ?? {})
              },
              mergePolicy: {
                ...(repo.sentinelConfig?.mergePolicy ?? {}),
                ...(patch.sentinelConfig?.mergePolicy ?? {})
              },
              conflictPolicy: {
                ...(repo.sentinelConfig?.conflictPolicy ?? {}),
                ...(patch.sentinelConfig?.conflictPolicy ?? {})
              }
            }
          : repo.sentinelConfig;
        const normalizedSentinelConfig = normalizeRepoSentinelConfig({
          sentinelConfig: {
            ...DEFAULT_REPO_SENTINEL_CONFIG,
            ...(mergedSentinelConfig ?? {}),
            reviewGate: {
              ...DEFAULT_REPO_SENTINEL_CONFIG.reviewGate,
              ...(mergedSentinelConfig?.reviewGate ?? {})
            },
            mergePolicy: {
              ...DEFAULT_REPO_SENTINEL_CONFIG.mergePolicy,
              ...(mergedSentinelConfig?.mergePolicy ?? {})
            },
            conflictPolicy: {
              ...DEFAULT_REPO_SENTINEL_CONFIG.conflictPolicy,
              ...(mergedSentinelConfig?.conflictPolicy ?? {})
            }
          }
        }).sentinelConfig;
        const mergedCheckpointConfig = hasCheckpointConfigPatch
          ? {
              ...(repo.checkpointConfig ?? DEFAULT_REPO_CHECKPOINT_CONFIG),
              ...patch.checkpointConfig,
              contextNotes: {
                ...(repo.checkpointConfig?.contextNotes ?? DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes),
                ...(patch.checkpointConfig?.contextNotes ?? {})
              },
              reviewPrep: {
                ...(repo.checkpointConfig?.reviewPrep ?? DEFAULT_REPO_CHECKPOINT_CONFIG.reviewPrep),
                ...(patch.checkpointConfig?.reviewPrep ?? {})
              }
            }
          : repo.checkpointConfig;
        const normalizedCheckpointConfig = normalizeRepoCheckpointConfig({
          checkpointConfig: mergedCheckpointConfig
        }).checkpointConfig;

        updatedRepo = normalizeRepo({
          ...repo,
          ...patch,
          autoReview: mergedAutoReview,
          sentinelConfig: normalizedSentinelConfig,
          checkpointConfig: normalizedCheckpointConfig,
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

  async getRepoSentinel(repoId: string): Promise<RepoSentinelStatus> {
    const repo = this.store.getSnapshot().repos.find((candidate) => candidate.repoId === repoId);
    if (!repo) {
      throw new Error(`Repo ${repoId} not found.`);
    }
    const events = this.repoSentinelEvents.get(repoId) ?? [];
    return {
      repoId,
      config: repo.sentinelConfig ?? DEFAULT_REPO_SENTINEL_CONFIG,
      run: this.repoSentinelRuns.get(repoId),
      events: [...events].sort((left, right) => right.at.localeCompare(left.at))
    };
  }

  async updateRepoSentinelConfig(repoId: string, patch: RepoSentinelConfigInput): Promise<RepoSentinelStatus> {
    await this.updateRepo(repoId, { sentinelConfig: patch });
    return this.getRepoSentinel(repoId);
  }

  async startRepoSentinel(repoId: string, input?: RepoSentinelStartInput): Promise<RepoSentinelActionResult> {
    const repo = this.store.getSnapshot().repos.find((candidate) => candidate.repoId === repoId);
    if (!repo) {
      throw new Error(`Repo ${repoId} not found.`);
    }
    const current = this.repoSentinelRuns.get(repoId);
    if (current?.status === 'running') {
      return { ...(await this.getRepoSentinel(repoId)), changed: false };
    }
    const now = nowIso();
    const next = current
      ? { ...current, status: 'running' as const, updatedAt: now }
      : {
          id: randomId('sentinel_run'),
          tenantId: repo.tenantId ?? 'tenant_local',
          repoId,
          scopeType: input?.scopeType ?? (repo.sentinelConfig?.globalMode ? 'global' : 'group'),
          scopeValue: input?.scopeValue ?? repo.sentinelConfig?.defaultGroupTag,
          status: 'running' as const,
          attemptCount: 0,
          startedAt: now,
          updatedAt: now
        };
    this.repoSentinelRuns.set(repoId, next);
    this.pushSentinelEvent(repoId, {
      id: randomId('sentinel_event'),
      sentinelRunId: next.id,
      tenantId: next.tenantId,
      repoId,
      at: now,
      level: 'info',
      type: current ? 'sentinel.resumed' : 'sentinel.started',
      message: current ? `Sentinel resumed for ${repo.slug}.` : `Sentinel started for ${repo.slug}.`
    });
    return { ...(await this.getRepoSentinel(repoId)), changed: true };
  }

  async pauseRepoSentinel(repoId: string): Promise<RepoSentinelActionResult> {
    const current = this.repoSentinelRuns.get(repoId);
    if (!current || current.status !== 'running') {
      return { ...(await this.getRepoSentinel(repoId)), changed: false };
    }
    const now = nowIso();
    const next = { ...current, status: 'paused' as const, updatedAt: now };
    this.repoSentinelRuns.set(repoId, next);
    this.pushSentinelEvent(repoId, {
      id: randomId('sentinel_event'),
      sentinelRunId: next.id,
      tenantId: next.tenantId,
      repoId,
      at: now,
      level: 'info',
      type: 'sentinel.paused',
      message: `Sentinel paused for ${repoId}.`
    });
    return { ...(await this.getRepoSentinel(repoId)), changed: true };
  }

  async resumeRepoSentinel(repoId: string): Promise<RepoSentinelActionResult> {
    const current = this.repoSentinelRuns.get(repoId);
    if (!current || current.status !== 'paused') {
      return { ...(await this.getRepoSentinel(repoId)), changed: false };
    }
    const now = nowIso();
    const next = { ...current, status: 'running' as const, updatedAt: now };
    this.repoSentinelRuns.set(repoId, next);
    this.pushSentinelEvent(repoId, {
      id: randomId('sentinel_event'),
      sentinelRunId: next.id,
      tenantId: next.tenantId,
      repoId,
      at: now,
      level: 'info',
      type: 'sentinel.resumed',
      message: `Sentinel resumed for ${repoId}.`
    });
    return { ...(await this.getRepoSentinel(repoId)), changed: true };
  }

  async stopRepoSentinel(repoId: string): Promise<RepoSentinelActionResult> {
    const current = this.repoSentinelRuns.get(repoId);
    if (!current || (current.status !== 'running' && current.status !== 'paused')) {
      return { ...(await this.getRepoSentinel(repoId)), changed: false };
    }
    const now = nowIso();
    const next = {
      ...current,
      status: 'stopped' as const,
      currentTaskId: undefined,
      currentRunId: undefined,
      updatedAt: now
    };
    this.repoSentinelRuns.set(repoId, next);
    this.pushSentinelEvent(repoId, {
      id: randomId('sentinel_event'),
      sentinelRunId: next.id,
      tenantId: next.tenantId,
      repoId,
      at: now,
      level: 'info',
      type: 'sentinel.stopped',
      message: `Sentinel stopped for ${repoId}.`
    });
    return { ...(await this.getRepoSentinel(repoId)), changed: true };
  }

  async listRepoSentinelEvents(repoId: string, options?: { limit?: number }) {
    const events = this.repoSentinelEvents.get(repoId) ?? [];
    const sorted = [...events].sort((left, right) => right.at.localeCompare(left.at));
    if (!options?.limit || options.limit < 1) {
      return sorted;
    }
    return sorted.slice(0, options.limit);
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
      tags: normalizeTaskTags(input.tags),
      baselineUrlOverride: input.baselineUrlOverride,
      status: input.status ?? 'INBOX',
      createdAt: timestamp,
      updatedAt: timestamp,
      uiMeta: normalizeTaskUiMeta({
        simulationProfile: input.simulationProfile ?? 'happy_path',
        autoReviewMode: input.autoReviewMode,
        autoReviewPrompt: input.autoReviewPrompt,
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

  async listTasks(filter?: { repoId?: string; tags?: string[] }): Promise<Task[]> {
    const tasks = getTasksForRepo(this.store.getSnapshot().tasks, filter?.repoId ?? 'all');
    const tags = normalizeTaskTags(filter?.tags);
    if (!tags) {
      return tasks;
    }
    return tasks.filter((task) => tags.every((tag) => task.tags?.includes(tag)));
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    const detail = getTaskDetail(this.store.getSnapshot(), taskId);
    if (!detail) {
      throw new Error(`Task ${taskId} not found.`);
    }

    return detail;
  }

  async getTaskCheckpoints(taskId: string, options?: { latest?: boolean }): Promise<RunCheckpoint[]> {
    const detail = await this.getTask(taskId);
    const checkpoints = detail.runs
      .flatMap((run) => run.checkpoints ?? [])
      .sort((left, right) => {
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        if (byCreatedAt !== 0) {
          return byCreatedAt;
        }
        return right.checkpointId.localeCompare(left.checkpointId);
      });
    return options?.latest ? checkpoints.slice(0, 1) : checkpoints;
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
          tags: Object.prototype.hasOwnProperty.call(patch, 'tags') ? normalizeTaskTags(patch.tags) : normalizeTaskTags(task.tags),
          acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria,
          uiMeta: normalizeTaskUiMeta({
            simulationProfile: patch.simulationProfile ?? task.uiMeta?.simulationProfile ?? 'happy_path',
            autoReviewMode: patch.autoReviewMode ?? task.uiMeta?.autoReviewMode ?? 'inherit',
            autoReviewPrompt: patch.autoReviewPrompt ?? task.uiMeta?.autoReviewPrompt,
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

  async getRunCheckpoints(runId: string): Promise<RunCheckpoint[]> {
    const run = await this.getRun(runId);
    return [...(run.checkpoints ?? [])];
  }

  async retryRun(runId: string, _input?: RetryRunInput): Promise<AgentRun> {
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

  async rerunReview(runId: string): Promise<AgentRun> {
    const run = await this.getRun(runId);
    const startedAt = nowIso();
    const round = (run.reviewExecution?.round ?? 0) + 1;
    const reviewExecution = {
      enabled: true,
      trigger: 'manual_rerun' as const,
      promptSource: run.reviewExecution?.promptSource ?? 'native',
      status: 'completed' as const,
      round,
      startedAt,
      endedAt: startedAt,
      durationMs: 0
    };

    let updatedRun: AgentRun | undefined;
    this.store.update((snapshot) => ({
      ...snapshot,
      runs: snapshot.runs.map((candidate) => {
        if (candidate.runId !== runId) {
          return candidate;
        }
        updatedRun = {
          ...candidate,
          reviewExecution,
          timeline: [...candidate.timeline, { status: candidate.status, at: startedAt, note: 'Manual review rerun completed (mock).' }]
        };
        return updatedRun;
      })
    }));

    if (!updatedRun) {
      throw new Error(`Run ${runId} not found.`);
    }
    return updatedRun;
  }

  async requestRunChanges(runId: string, input: RequestRunChangesInput): Promise<AgentRun> {
    const run = await this.getRun(runId);
    const task = this.store.getSnapshot().tasks.find((candidate) => candidate.taskId === run.taskId);
    if (!task) {
      throw new Error(`Task ${run.taskId} not found.`);
    }

    const selection = input.reviewSelection
      ? {
          mode: input.reviewSelection.mode,
          requestedFindingIds: input.reviewSelection.findingIds,
          selectedFindingIds: input.reviewSelection.findingIds ?? [],
          includeReplies: input.reviewSelection.includeReplies,
          instruction: input.reviewSelection.instruction?.trim()
        }
      : undefined;

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
        changeRequest: {
          prompt: input.prompt,
          requestedAt: nowIso(),
          ...(selection ? { selection } : {})
        }
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

  private pushSentinelEvent(repoId: string, event: RepoSentinelStatus['events'][number]) {
    const existing = this.repoSentinelEvents.get(repoId) ?? [];
    this.repoSentinelEvents.set(repoId, [event, ...existing].slice(0, 500));
  }
}

function normalizeTaskTags(tags: Task['tags']) {
  if (!Array.isArray(tags)) {
    return undefined;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length ? normalized : undefined;
}

let singleton: LocalAgentBoardApi | undefined;

export function getLocalAgentBoardApi() {
  singleton ??= new LocalAgentBoardApi(new LocalBoardStore());
  return singleton;
}

export function resetLocalAgentBoardApi() {
  singleton = undefined;
}
