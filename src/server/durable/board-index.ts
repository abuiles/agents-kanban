import type { CreateRepoInput, UpdateRepoInput, UpsertScmCredentialInput } from '../../ui/domain/api';
import type { BoardSnapshotV1, Repo, ScmCredential, ScmProvider, Tenant, TenantMember, TenantSeatSummary } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { conflict, forbidden, notFound } from '../http/errors';
import { createRepoId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { buildBoardSnapshot, type BoardSyncResponse } from '../shared/state';
import { buildRepoScmKey, getRepoHost, getRepoProjectPath, normalizeCredentialHost, normalizeRepo } from '../../shared/scm';
import { DEFAULT_TENANT_ID, normalizeTenantId } from '../../shared/tenant';

const REPOS_STORAGE_KEY = 'board-index-repos';
const SCM_CREDENTIALS_STORAGE_KEY = 'board-index-scm-credentials';
const TENANTS_STORAGE_KEY = 'board-index-tenants';
const TENANT_MEMBERSHIPS_STORAGE_KEY = 'board-index-tenant-memberships';
const DEFAULT_SEAT_LIMIT = 5;
const SYSTEM_USER_ID = 'user_system';

type StoredScmCredential = ScmCredential & {
  token: string;
};

type TenantRecordInput = {
  name: string;
  slug: string;
  domain?: string;
  seatLimit?: number;
  defaultSeatLimit?: number;
};

type TenantMemberRecordInput = {
  userId: string;
  role?: TenantMember['role'];
  seatState?: TenantMember['seatState'];
};

export class BoardIndexDO extends DurableObject<Env> {
  private repos: Repo[] = [];
  private scmCredentials: StoredScmCredential[] = [];
  private tenants: Tenant[] = [];
  private tenantMemberships: TenantMember[] = [];
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const storedRepos = (await this.ctx.storage.get<Repo[]>(REPOS_STORAGE_KEY)) ?? [];
      const storedScmCredentials = (await this.ctx.storage.get<StoredScmCredential[]>(SCM_CREDENTIALS_STORAGE_KEY)) ?? [];
      const storedTenants = (await this.ctx.storage.get<Tenant[]>(TENANTS_STORAGE_KEY)) ?? [];
      const storedTenantMemberships = (await this.ctx.storage.get<TenantMember[]>(TENANT_MEMBERSHIPS_STORAGE_KEY)) ?? [];
      this.repos = storedRepos.map((repo) => normalizeRepo(repo));
      this.scmCredentials = storedScmCredentials.map((credential) => normalizeStoredScmCredential(credential));
      this.tenants = storedTenants.map((tenant) => normalizeTenantRecord(tenant));
      this.tenantMemberships = storedTenantMemberships.map((membership) => normalizeTenantMemberRecord(membership));
      this.ensureBootstrapTenantAndOwner();
      await this.persist();
    });
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      const repoId = url.searchParams.get('repoId') ?? 'all';
      return this.handleWebSocket(repoId);
    }

    return new Response('Not found', { status: 404 });
  }

  async listRepos(tenantId?: string) {
    await this.ready;
    const normalizedTenantId = tenantId ? normalizeTenantId(tenantId) : undefined;
    return [...this.repos]
      .filter((repo) => !normalizedTenantId || normalizeTenantId(repo.tenantId) === normalizedTenantId)
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async getRepo(repoId: string) {
    await this.ready;
    const repo = this.repos.find((candidate) => candidate.repoId === repoId);
    if (!repo) {
      throw notFound(`Repo ${repoId} not found.`);
    }
    return repo;
  }

  async listTenantsForUser(userId: string): Promise<Tenant[]> {
    await this.ready;
    const allowedTenantIds = new Set(
      this.tenantMemberships
        .filter((membership) => membership.userId === userId && membership.seatState === 'active')
        .map((membership) => membership.tenantId)
    );
    return [...this.tenants]
      .filter((tenant) => allowedTenantIds.has(tenant.id))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async getTenant(tenantId: string): Promise<Tenant> {
    await this.ready;
    const normalizedTenantId = normalizeTenantId(tenantId);
    const tenant = this.tenants.find((candidate) => candidate.id === normalizedTenantId);
    if (!tenant) {
      throw notFound(`Tenant ${normalizedTenantId} not found.`);
    }
    return tenant;
  }

  async getTenantMembership(tenantId: string, userId: string): Promise<TenantMember | undefined> {
    await this.ready;
    const normalizedTenantId = normalizeTenantId(tenantId);
    return this.tenantMemberships.find((membership) => membership.tenantId === normalizedTenantId && membership.userId === userId);
  }

  async hasActiveTenantAccess(tenantId: string, userId: string): Promise<boolean> {
    await this.ready;
    const membership = await this.getTenantMembership(tenantId, userId);
    return Boolean(membership && membership.seatState === 'active');
  }

  async listTenantMembers(tenantId: string): Promise<TenantMember[]> {
    await this.ready;
    const normalizedTenantId = normalizeTenantId(tenantId);
    return [...this.tenantMemberships]
      .filter((membership) => membership.tenantId === normalizedTenantId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getTenantSeatSummary(tenantId: string): Promise<TenantSeatSummary> {
    await this.ready;
    const tenant = await this.getTenant(tenantId);
    const seatsUsed = this.tenantMemberships.filter((membership) => membership.tenantId === tenant.id && membership.seatState === 'active').length;
    return {
      tenantId: tenant.id,
      seatLimit: tenant.seatLimit,
      seatsUsed,
      seatsAvailable: Math.max(0, tenant.seatLimit - seatsUsed)
    };
  }

  async createTenant(input: TenantRecordInput, actorUserId: string): Promise<{ tenant: Tenant; ownerMembership: TenantMember; seatSummary: TenantSeatSummary }> {
    await this.ready;
    const slug = normalizeTenantSlug(input.slug);
    if (this.tenants.some((tenant) => tenant.slug === slug)) {
      throw conflict(`Tenant slug ${slug} already exists.`);
    }
    const now = new Date().toISOString();
    const tenant: Tenant = normalizeTenantRecord({
      id: createTenantId(slug),
      slug,
      name: input.name.trim(),
      status: 'active',
      domain: input.domain?.trim() || undefined,
      createdByUserId: actorUserId,
      defaultSeatLimit: input.defaultSeatLimit ?? input.seatLimit ?? DEFAULT_SEAT_LIMIT,
      seatLimit: input.seatLimit ?? input.defaultSeatLimit ?? DEFAULT_SEAT_LIMIT,
      settings: undefined,
      createdAt: now,
      updatedAt: now
    });
    const ownerMembership: TenantMember = normalizeTenantMemberRecord({
      id: createTenantMemberId(tenant.id, actorUserId),
      tenantId: tenant.id,
      userId: actorUserId,
      role: 'owner',
      seatState: 'active',
      createdAt: now,
      updatedAt: now
    });

    this.tenants = [tenant, ...this.tenants];
    this.tenantMemberships = [...this.tenantMemberships, ownerMembership];
    await this.persist();
    return {
      tenant,
      ownerMembership,
      seatSummary: await this.getTenantSeatSummary(tenant.id)
    };
  }

  async createTenantMember(tenantId: string, input: TenantMemberRecordInput, actorUserId: string): Promise<{ member: TenantMember; seatSummary: TenantSeatSummary }> {
    await this.ready;
    const tenant = await this.getTenant(tenantId);
    await this.assertOwnerAccess(tenant.id, actorUserId);

    if (this.tenantMemberships.some((membership) => membership.tenantId === tenant.id && membership.userId === input.userId)) {
      throw conflict(`Member ${input.userId} already exists in tenant ${tenant.id}.`);
    }

    if ((input.seatState ?? 'active') === 'active') {
      this.assertSeatCapacity(tenant.id);
    }

    const now = new Date().toISOString();
    const member: TenantMember = normalizeTenantMemberRecord({
      id: createTenantMemberId(tenant.id, input.userId),
      tenantId: tenant.id,
      userId: input.userId,
      role: input.role ?? 'member',
      seatState: input.seatState ?? 'active',
      createdAt: now,
      updatedAt: now
    });
    this.tenantMemberships = [...this.tenantMemberships, member];
    await this.persist();
    return {
      member,
      seatSummary: await this.getTenantSeatSummary(tenant.id)
    };
  }

  async updateTenantMember(
    tenantId: string,
    memberId: string,
    patch: Pick<TenantMemberRecordInput, 'role' | 'seatState'>,
    actorUserId: string
  ): Promise<{ member: TenantMember; seatSummary: TenantSeatSummary }> {
    await this.ready;
    const tenant = await this.getTenant(tenantId);
    await this.assertOwnerAccess(tenant.id, actorUserId);

    const existing = this.tenantMemberships.find((membership) => membership.tenantId === tenant.id && membership.id === memberId);
    if (!existing) {
      throw notFound(`Member ${memberId} not found in tenant ${tenant.id}.`);
    }

    if (existing.seatState !== 'active' && patch.seatState === 'active') {
      this.assertSeatCapacity(tenant.id);
    }

    const updated: TenantMember = normalizeTenantMemberRecord({
      ...existing,
      role: patch.role ?? existing.role,
      seatState: patch.seatState ?? existing.seatState,
      updatedAt: new Date().toISOString()
    });

    if (existing.role === 'owner' && (updated.role !== 'owner' || updated.seatState !== 'active')) {
      const otherActiveOwners = this.tenantMemberships.filter(
        (membership) =>
          membership.tenantId === tenant.id
          && membership.id !== existing.id
          && membership.role === 'owner'
          && membership.seatState === 'active'
      );
      if (otherActiveOwners.length === 0) {
        throw forbidden(`Tenant ${tenant.id} requires at least one active owner.`);
      }
    }

    this.tenantMemberships = this.tenantMemberships.map((membership) =>
      membership.id === memberId && membership.tenantId === tenant.id ? updated : membership
    );
    await this.persist();
    return {
      member: updated,
      seatSummary: await this.getTenantSeatSummary(tenant.id)
    };
  }

  async createRepo(input: CreateRepoInput) {
    await this.ready;
    const candidate = buildRepoRecord(input);
    if (this.repos.some((repo) => buildRepoScmKey(repo) === buildRepoScmKey(candidate))) {
      throw conflict(`Repo ${candidate.slug} already exists.`);
    }

    const repo = {
      ...candidate,
      repoId: createRepoIdentity(candidate),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.repos = [repo, ...this.repos];
    await this.persist();
    await this.broadcast({ type: 'repo.updated', payload: { repo } }, repo.repoId);
    return repo;
  }

  async updateRepo(repoId: string, patch: UpdateRepoInput) {
    await this.ready;
    const existing = await this.getRepo(repoId);
    const updated = buildRepoRecord({
      ...existing,
      ...patch,
      slug: patch.slug ?? patch.projectPath ?? existing.slug,
      projectPath: patch.projectPath ?? patch.slug ?? existing.projectPath,
      repoId: existing.repoId,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt
    });
    if (
      this.repos.some((repo) => repo.repoId !== repoId && buildRepoScmKey(repo) === buildRepoScmKey(updated))
    ) {
      throw conflict(`Repo ${updated.slug} already exists.`);
    }

    this.repos = this.repos.map((repo) =>
      repo.repoId === repoId
        ? {
            ...updated,
            repoId,
            createdAt: existing.createdAt,
            updatedAt: new Date().toISOString()
          }
        : repo
    );
    await this.persist();
    const finalRepo = this.repos.find((repo) => repo.repoId === repoId) ?? existing;
    await this.broadcast({ type: 'repo.updated', payload: { repo: finalRepo } }, repoId);
    return finalRepo;
  }

  async listScmCredentials(): Promise<ScmCredential[]> {
    await this.ready;
    return [...this.scmCredentials]
      .sort((left, right) => left.credentialId.localeCompare(right.credentialId))
      .map(stripScmCredentialSecret);
  }

  async getScmCredential(scmProvider: ScmProvider, host: string): Promise<ScmCredential | undefined> {
    await this.ready;
    const credential = this.scmCredentials.find((candidate) => candidate.credentialId === buildScmCredentialId(scmProvider, host));
    return credential ? stripScmCredentialSecret(credential) : undefined;
  }

  async getScmCredentialSecret(scmProvider: ScmProvider, host: string): Promise<string | undefined> {
    await this.ready;
    return this.scmCredentials.find((candidate) => candidate.credentialId === buildScmCredentialId(scmProvider, host))?.token;
  }

  async upsertScmCredential(input: UpsertScmCredentialInput): Promise<ScmCredential> {
    await this.ready;
    const now = new Date().toISOString();
    const credentialId = buildScmCredentialId(input.scmProvider, input.host);
    const existing = this.scmCredentials.find((candidate) => candidate.credentialId === credentialId);
    const credential: StoredScmCredential = normalizeStoredScmCredential({
      credentialId,
      scmProvider: input.scmProvider,
      host: input.host,
      label: input.label,
      hasSecret: true,
      token: input.token,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });

    this.scmCredentials = existing
      ? this.scmCredentials.map((candidate) => (candidate.credentialId === credentialId ? credential : candidate))
      : [...this.scmCredentials, credential];
    await this.persist();
    return stripScmCredentialSecret(credential);
  }

  async getBoardSync(repoId?: string, tenantId?: string): Promise<BoardSyncResponse> {
    await this.ready;
    const normalizedTenantId = tenantId ? normalizeTenantId(tenantId) : undefined;
    const repos = await this.listRepos(normalizedTenantId);
    const selected = repoId && repoId !== 'all' ? repos.filter((repo) => repo.repoId === repoId) : repos;
    const slices = await Promise.all(selected.map((repo) => this.env.REPO_BOARD.getByName(repo.repoId).getBoardSlice()));
    const tasks = slices.flatMap((slice) => slice.tasks);
    const runs = slices.flatMap((slice) => slice.runs);
    const logs = slices.flatMap((slice) => slice.logs);
    const events = slices.flatMap((slice) => slice.events ?? []);
    const commands = slices.flatMap((slice) => slice.commands ?? []);

    return {
      repos,
      tasks: tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      runs: runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
      logs: logs.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      events: events.sort((left, right) => left.at.localeCompare(right.at)),
      commands: commands.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    };
  }

  async exportBoard(): Promise<BoardSnapshotV1> {
    return buildBoardSnapshot(await this.getBoardSync('all'));
  }

  async importBoard(snapshot: BoardSnapshotV1) {
    await this.ready;
    const previousRepoIds = new Set(this.repos.map((repo) => repo.repoId));
    this.repos = snapshot.repos.map((repo) => normalizeRepo(repo));
    await this.persist();

    const nextRepoIds = new Set(snapshot.repos.map((repo) => repo.repoId));
    const allRepoIds = new Set([...previousRepoIds, ...nextRepoIds]);

    await Promise.all(
      [...allRepoIds].map(async (repoId) => {
        const repoState = {
          tasks: snapshot.tasks.filter((task) => task.repoId === repoId),
          runs: snapshot.runs.filter((run) => run.repoId === repoId),
          logs: snapshot.logs.filter((log) => {
            const run = snapshot.runs.find((candidate) => candidate.runId === log.runId);
            return run?.repoId === repoId;
          }),
          events: snapshot.events.filter((event) => event.repoId === repoId),
          commands: snapshot.commands.filter((command) => {
            const run = snapshot.runs.find((candidate) => candidate.runId === command.runId);
            return run?.repoId === repoId;
          })
        };
        await this.env.REPO_BOARD.getByName(repoId).replaceState(repoState);
      })
    );

    await this.broadcast({ type: 'board.snapshot', payload: await this.getBoardSync('all') });
  }

  async findTaskRepoId(taskId: string) {
    await this.ready;
    for (const repo of this.repos) {
      if (await this.env.REPO_BOARD.getByName(repo.repoId).hasTask(taskId)) {
        return repo.repoId;
      }
    }

    return undefined;
  }

  async findRunRepoId(runId: string) {
    await this.ready;
    for (const repo of this.repos) {
      if (await this.env.REPO_BOARD.getByName(repo.repoId).hasRun(runId)) {
        return repo.repoId;
      }
    }

    return undefined;
  }

  async notifyRepoEvent(event: BoardEvent & { repoId?: string }) {
    await this.ready;
    const message = stringifyBoardEvent(event);
    for (const socket of this.ctx.getWebSockets('scope:all')) {
      socket.send(message);
    }

    if (event.repoId) {
      for (const socket of this.ctx.getWebSockets(`scope:repo:${event.repoId}`)) {
        socket.send(message);
      }
    }
  }

  private async handleWebSocket(repoId: string) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tag = repoId === 'all' ? 'scope:all' : `scope:repo:${repoId}`;
    this.ctx.acceptWebSocket(server, [tag]);
    server.send(stringifyBoardEvent({ type: 'board.snapshot', payload: await this.getBoardSync(repoId) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(event: BoardEvent, repoId?: string) {
    await this.notifyRepoEvent({ ...event, repoId });
  }

  private async persist() {
    await this.ctx.storage.put(REPOS_STORAGE_KEY, this.repos);
    await this.ctx.storage.put(SCM_CREDENTIALS_STORAGE_KEY, this.scmCredentials);
    await this.ctx.storage.put(TENANTS_STORAGE_KEY, this.tenants);
    await this.ctx.storage.put(TENANT_MEMBERSHIPS_STORAGE_KEY, this.tenantMemberships);
  }

  private ensureBootstrapTenantAndOwner() {
    const now = new Date().toISOString();
    if (!this.tenants.some((tenant) => tenant.id === DEFAULT_TENANT_ID)) {
      this.tenants = [
        normalizeTenantRecord({
          id: DEFAULT_TENANT_ID,
          slug: DEFAULT_TENANT_ID,
          name: 'Legacy Tenant',
          status: 'active',
          createdByUserId: SYSTEM_USER_ID,
          defaultSeatLimit: 100,
          seatLimit: 100,
          createdAt: now,
          updatedAt: now
        }),
        ...this.tenants
      ];
    }
    if (!this.tenantMemberships.some((membership) => membership.tenantId === DEFAULT_TENANT_ID && membership.userId === SYSTEM_USER_ID)) {
      this.tenantMemberships = [
        normalizeTenantMemberRecord({
          id: createTenantMemberId(DEFAULT_TENANT_ID, SYSTEM_USER_ID),
          tenantId: DEFAULT_TENANT_ID,
          userId: SYSTEM_USER_ID,
          role: 'owner',
          seatState: 'active',
          createdAt: now,
          updatedAt: now
        }),
        ...this.tenantMemberships
      ];
    }
  }

  private async assertOwnerAccess(tenantId: string, userId: string) {
    const membership = await this.getTenantMembership(tenantId, userId);
    if (!membership || membership.seatState !== 'active') {
      throw forbidden(`User ${userId} does not have an active seat in tenant ${tenantId}.`);
    }
    if (membership.role !== 'owner') {
      throw forbidden(`User ${userId} must be an owner of tenant ${tenantId}.`);
    }
  }

  private assertSeatCapacity(tenantId: string) {
    const tenant = this.tenants.find((candidate) => candidate.id === tenantId);
    if (!tenant) {
      throw notFound(`Tenant ${tenantId} not found.`);
    }
    const seatsUsed = this.tenantMemberships.filter((membership) => membership.tenantId === tenantId && membership.seatState === 'active').length;
    if (seatsUsed >= tenant.seatLimit) {
      throw conflict(`Tenant ${tenantId} has no available seats.`);
    }
  }
}

function buildRepoRecord(input: CreateRepoInput | Repo): Repo {
  const normalized = normalizeRepo({
    ...input,
    repoId: 'repoId' in input ? input.repoId : '',
    defaultBranch: input.defaultBranch ?? 'main',
    baselineUrl: input.baselineUrl,
    enabled: input.enabled ?? true,
    llmAdapter: input.llmAdapter,
    llmProfileId: input.llmProfileId,
    githubAuthMode: 'githubAuthMode' in input ? input.githubAuthMode : undefined,
    previewMode: 'previewMode' in input ? input.previewMode : 'auto',
    evidenceMode: 'evidenceMode' in input ? input.evidenceMode : 'auto',
    previewAdapter: 'previewAdapter' in input ? input.previewAdapter : undefined,
    previewConfig: 'previewConfig' in input ? input.previewConfig : undefined,
    previewProvider: 'previewProvider' in input ? input.previewProvider : undefined,
    previewCheckName: input.previewCheckName,
    previewUrlPattern: 'previewUrlPattern' in input ? input.previewUrlPattern : undefined,
    llmAuthBundleR2Key: input.llmAuthBundleR2Key ?? input.codexAuthBundleR2Key,
    codexAuthBundleR2Key: input.codexAuthBundleR2Key ?? input.llmAuthBundleR2Key,
    createdAt: 'createdAt' in input ? input.createdAt : '',
    updatedAt: 'updatedAt' in input ? input.updatedAt : ''
  });

  return normalized;
}

function createRepoIdentity(repo: Repo): string {
  const host = getRepoHost(repo);
  const projectPath = getRepoProjectPath(repo);
  if (repo.scmProvider === 'github' && host === 'github.com') {
    return createRepoId(projectPath);
  }

  return createRepoId(`${repo.scmProvider}_${host}_${projectPath}`);
}

function buildScmCredentialId(scmProvider: ScmProvider, host: string) {
  return `${scmProvider}:${normalizeCredentialHost(host)}`;
}

function normalizeStoredScmCredential(credential: StoredScmCredential): StoredScmCredential {
  return {
    ...credential,
    credentialId: buildScmCredentialId(credential.scmProvider, credential.host),
    host: normalizeCredentialHost(credential.host),
    hasSecret: Boolean(credential.token)
  };
}

function stripScmCredentialSecret(credential: StoredScmCredential): ScmCredential {
  return {
    credentialId: credential.credentialId,
    scmProvider: credential.scmProvider,
    host: credential.host,
    label: credential.label,
    hasSecret: credential.hasSecret,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt
  };
}

function normalizeTenantSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('Invalid tenant slug.');
  }
  return slug;
}

function createTenantId(slug: string): string {
  return `tenant_${slug}`;
}

function createTenantMemberId(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

function normalizeTenantRecord(tenant: Tenant): Tenant {
  return {
    ...tenant,
    id: normalizeTenantId(tenant.id),
    slug: normalizeTenantSlug(tenant.slug),
    name: tenant.name.trim(),
    status: tenant.status === 'suspended' ? 'suspended' : 'active',
    createdByUserId: tenant.createdByUserId.trim(),
    defaultSeatLimit: tenant.defaultSeatLimit > 0 ? Math.floor(tenant.defaultSeatLimit) : DEFAULT_SEAT_LIMIT,
    seatLimit: tenant.seatLimit > 0 ? Math.floor(tenant.seatLimit) : DEFAULT_SEAT_LIMIT
  };
}

function normalizeTenantMemberRecord(member: TenantMember): TenantMember {
  return {
    ...member,
    id: member.id.trim(),
    tenantId: normalizeTenantId(member.tenantId),
    userId: member.userId.trim(),
    role: member.role === 'owner' ? 'owner' : 'member',
    seatState: member.seatState === 'invited' || member.seatState === 'revoked' ? member.seatState : 'active'
  };
}
