import type { CreateRepoInput, UpdateRepoInput, UpsertScmCredentialInput } from '../../ui/domain/api';
import type { BoardSnapshotV1, Repo, ScmCredential, ScmProvider, Tenant, TenantMember, TenantSeatSummary, User, UserSession } from '../../ui/domain/types';
import { DurableObject } from 'cloudflare:workers';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../http/errors';
import { createRepoId } from '../shared/ids';
import type { BoardEvent } from '../shared/events';
import { stringifyBoardEvent } from '../shared/events';
import { buildBoardSnapshot, type BoardSyncResponse } from '../shared/state';
import { buildRepoScmKey, getAutoReviewProviderDefaultForScm, getRepoHost, getRepoProjectPath, normalizeCredentialHost, normalizeRepo } from '../../shared/scm';
import { DEFAULT_REPO_CHECKPOINT_CONFIG, normalizeRepoCheckpointConfig } from '../../shared/checkpoint';
import { DEFAULT_REPO_SENTINEL_CONFIG, normalizeRepoSentinelConfig } from '../../shared/sentinel';
import { DEFAULT_TENANT_ID, normalizeTenantId } from '../../shared/tenant';

const REPOS_STORAGE_KEY = 'board-index-repos';
const SCM_CREDENTIALS_STORAGE_KEY = 'board-index-scm-credentials';
const TENANTS_STORAGE_KEY = 'board-index-tenants';
const TENANT_MEMBERSHIPS_STORAGE_KEY = 'board-index-tenant-memberships';
const USERS_STORAGE_KEY = 'board-index-users';
const USER_SESSIONS_STORAGE_KEY = 'board-index-user-sessions';
const TENANT_INVITES_STORAGE_KEY = 'board-index-tenant-invites';
const PLATFORM_ADMINS_STORAGE_KEY = 'board-index-platform-admins';
const PLATFORM_SUPPORT_SESSIONS_STORAGE_KEY = 'board-index-platform-support-sessions';
const SECURITY_AUDIT_LOG_STORAGE_KEY = 'board-index-security-audit-log';
const DEFAULT_SEAT_LIMIT = 5;
const SYSTEM_USER_ID = 'user_system';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const PLATFORM_SESSION_TTL_MS = 1000 * 60 * 60 * 8;

type StoredScmCredential = ScmCredential & {
  token: string;
};

type StoredUser = User & {
  passwordHash: string;
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

type TenantInvite = {
  id: string;
  tenantId: string;
  email: string;
  role: TenantMember['role'];
  status: 'pending' | 'accepted' | 'revoked';
  tokenHash: string;
  createdByUserId: string;
  acceptedByUserId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type PlatformAdmin = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

type PlatformSupportSession = {
  id: string;
  tokenHash: string;
  adminId: string;
  tenantId: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  releasedAt?: string;
};

type SecurityAuditLogEntry = {
  id: string;
  at: string;
  actorType: 'tenant_user' | 'platform_admin';
  actorId: string;
  action: string;
  tenantId?: string;
  metadata?: Record<string, string | number | boolean>;
};

export class BoardIndexDO extends DurableObject<Env> {
  private repos: Repo[] = [];
  private scmCredentials: StoredScmCredential[] = [];
  private tenants: Tenant[] = [];
  private tenantMemberships: TenantMember[] = [];
  private users: StoredUser[] = [];
  private userSessions: UserSession[] = [];
  private tenantInvites: TenantInvite[] = [];
  private platformAdmins: PlatformAdmin[] = [];
  private platformSupportSessions: PlatformSupportSession[] = [];
  private securityAuditLog: SecurityAuditLogEntry[] = [];
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const storedRepos = (await this.ctx.storage.get<Repo[]>(REPOS_STORAGE_KEY)) ?? [];
      const storedScmCredentials = (await this.ctx.storage.get<StoredScmCredential[]>(SCM_CREDENTIALS_STORAGE_KEY)) ?? [];
      const storedTenants = (await this.ctx.storage.get<Tenant[]>(TENANTS_STORAGE_KEY)) ?? [];
      const storedTenantMemberships = (await this.ctx.storage.get<TenantMember[]>(TENANT_MEMBERSHIPS_STORAGE_KEY)) ?? [];
      const storedUsers = (await this.ctx.storage.get<StoredUser[]>(USERS_STORAGE_KEY)) ?? [];
      const storedSessions = (await this.ctx.storage.get<UserSession[]>(USER_SESSIONS_STORAGE_KEY)) ?? [];
      const storedInvites = (await this.ctx.storage.get<TenantInvite[]>(TENANT_INVITES_STORAGE_KEY)) ?? [];
      const storedPlatformAdmins = (await this.ctx.storage.get<PlatformAdmin[]>(PLATFORM_ADMINS_STORAGE_KEY)) ?? [];
      const storedPlatformSupportSessions = (await this.ctx.storage.get<PlatformSupportSession[]>(PLATFORM_SUPPORT_SESSIONS_STORAGE_KEY)) ?? [];
      const storedSecurityAuditLog = (await this.ctx.storage.get<SecurityAuditLogEntry[]>(SECURITY_AUDIT_LOG_STORAGE_KEY)) ?? [];
      this.repos = storedRepos.map((repo) => normalizeRepo(repo));
      this.scmCredentials = storedScmCredentials.map((credential) => normalizeStoredScmCredential(credential));
      this.tenants = storedTenants.map((tenant) => normalizeTenantRecord(tenant));
      this.tenantMemberships = storedTenantMemberships.map((membership) => normalizeTenantMemberRecord(membership));
      this.users = storedUsers.map((user) => normalizeStoredUserRecord(user));
      this.userSessions = storedSessions.map((session) => normalizeUserSessionRecord(session));
      this.tenantInvites = storedInvites.map((invite) => normalizeTenantInviteRecord(invite));
      this.platformAdmins = storedPlatformAdmins.map((admin) => normalizePlatformAdminRecord(admin));
      this.platformSupportSessions = storedPlatformSupportSessions.map((session) => normalizePlatformSupportSessionRecord(session));
      this.securityAuditLog = storedSecurityAuditLog.map((entry) => normalizeSecurityAuditLogEntry(entry));
      this.ensureBootstrapTenantAndOwner();
      await this.ensureBootstrapPlatformAdmin();
      this.pruneExpiredSessions();
      this.pruneExpiredInvites();
      this.pruneExpiredPlatformSupportSessions();
      await this.persist();
    });
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      const repoId = url.searchParams.get('repoId') ?? 'all';
      const tenantId = url.searchParams.get('tenantId') ?? request.headers.get('x-tenant-id') ?? undefined;
      if (!tenantId) {
        throw badRequest('Missing tenantId for board websocket subscription.');
      }
      return this.handleWebSocket(repoId, tenantId);
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

  async createTenantInvite(
    tenantId: string,
    input: { email: string; role?: TenantMember['role'] },
    actorUserId: string
  ): Promise<{ invite: Omit<TenantInvite, 'tokenHash'>; token: string; seatSummary: TenantSeatSummary }> {
    await this.ready;
    const tenant = await this.getTenant(tenantId);
    await this.assertOwnerAccess(tenant.id, actorUserId);
    const normalizedEmail = normalizeEmail(input.email);
    const existingPending = this.tenantInvites.find(
      (invite) => invite.tenantId === tenant.id && invite.email === normalizedEmail && invite.status === 'pending'
    );
    if (existingPending) {
      throw conflict(`Pending invite for ${normalizedEmail} already exists in tenant ${tenant.id}.`);
    }
    const role = input.role ?? 'member';
    if (role === 'owner') {
      this.assertSeatCapacity(tenant.id);
    }
    const now = new Date().toISOString();
    const token = createAuthToken();
    const invite: TenantInvite = normalizeTenantInviteRecord({
      id: `invite_${crypto.randomUUID()}`,
      tenantId: tenant.id,
      email: normalizedEmail,
      role,
      status: 'pending',
      tokenHash: await hashSecret(token),
      createdByUserId: actorUserId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      createdAt: now,
      updatedAt: now
    });
    this.tenantInvites = [invite, ...this.tenantInvites];
    this.logSecurityEvent({
      actorType: 'tenant_user',
      actorId: actorUserId,
      action: 'tenant.invite.created',
      tenantId: tenant.id,
      metadata: { inviteId: invite.id, email: invite.email, role: invite.role }
    });
    await this.persist();
    const { tokenHash, ...safeInvite } = invite;
    void tokenHash;
    return { invite: safeInvite, token, seatSummary: await this.getTenantSeatSummary(tenant.id) };
  }

  async listTenantInvites(tenantId: string, actorUserId: string): Promise<Array<Omit<TenantInvite, 'tokenHash'>>> {
    await this.ready;
    const normalizedTenantId = normalizeTenantId(tenantId);
    await this.assertOwnerAccess(normalizedTenantId, actorUserId);
    return this.tenantInvites
      .filter((invite) => invite.tenantId === normalizedTenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((invite) => {
        const { tokenHash, ...safeInvite } = invite;
        void tokenHash;
        return safeInvite;
      });
  }

  async acceptTenantInvite(token: string, actorUserId: string): Promise<{ membership: TenantMember; invite: Omit<TenantInvite, 'tokenHash'> }> {
    await this.ready;
    this.pruneExpiredInvites();
    const tokenHash = await hashSecret(token);
    const invite = this.tenantInvites.find((candidate) => candidate.tokenHash === tokenHash && candidate.status === 'pending');
    if (!invite) {
      throw unauthorized('Invalid or expired invite.');
    }
    const user = this.users.find((candidate) => candidate.id === actorUserId);
    if (!user || normalizeEmail(user.email) !== invite.email) {
      throw forbidden('Invite email does not match authenticated user.');
    }
    const existingMembership = this.tenantMemberships.find((membership) => membership.tenantId === invite.tenantId && membership.userId === actorUserId);
    if (existingMembership && existingMembership.seatState === 'active') {
      throw conflict(`User ${actorUserId} already has an active seat in tenant ${invite.tenantId}.`);
    }
    if (!existingMembership || existingMembership.seatState !== 'active') {
      this.assertSeatCapacity(invite.tenantId);
    }
    const now = new Date().toISOString();
    const membership: TenantMember = normalizeTenantMemberRecord({
      id: createTenantMemberId(invite.tenantId, actorUserId),
      tenantId: invite.tenantId,
      userId: actorUserId,
      role: invite.role,
      seatState: 'active',
      createdAt: existingMembership?.createdAt ?? now,
      updatedAt: now
    });
    this.tenantMemberships = existingMembership
      ? this.tenantMemberships.map((candidate) => (candidate.id === existingMembership.id ? membership : candidate))
      : [...this.tenantMemberships, membership];
    const updatedInvite: TenantInvite = normalizeTenantInviteRecord({
      ...invite,
      status: 'accepted',
      acceptedByUserId: actorUserId,
      acceptedAt: now,
      updatedAt: now
    });
    this.tenantInvites = this.tenantInvites.map((candidate) => (candidate.id === invite.id ? updatedInvite : candidate));
    this.logSecurityEvent({
      actorType: 'tenant_user',
      actorId: actorUserId,
      action: 'tenant.invite.accepted',
      tenantId: invite.tenantId,
      metadata: { inviteId: invite.id, membershipId: membership.id }
    });
    await this.persist();
    const { tokenHash: _, ...safeInvite } = updatedInvite;
    void _;
    return { membership, invite: safeInvite };
  }

  async platformLogin(input: { email: string; password: string }) {
    await this.ready;
    const email = normalizeEmail(input.email);
    const admin = this.platformAdmins.find((candidate) => normalizeEmail(candidate.email) === email);
    if (!admin) {
      throw unauthorized('Invalid platform admin credentials.');
    }
    const passwordHash = await hashSecret(input.password);
    if (passwordHash !== admin.passwordHash) {
      throw unauthorized('Invalid platform admin credentials.');
    }
    const token = createAuthToken();
    const session: PlatformSupportSession = normalizePlatformSupportSessionRecord({
      id: `psess_${crypto.randomUUID()}`,
      tokenHash: await hashSecret(token),
      adminId: admin.id,
      tenantId: DEFAULT_TENANT_ID,
      reason: 'platform-auth',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PLATFORM_SESSION_TTL_MS).toISOString()
    });
    this.platformSupportSessions = [session, ...this.platformSupportSessions];
    this.logSecurityEvent({
      actorType: 'platform_admin',
      actorId: admin.id,
      action: 'platform.auth.login'
    });
    await this.persist();
    return { admin: { id: admin.id, email: admin.email }, token };
  }

  async resolvePlatformAdminByToken(token: string): Promise<{ admin: { id: string; email: string } }> {
    await this.ready;
    this.pruneExpiredPlatformSupportSessions();
    const tokenHash = await hashSecret(token);
    const session = this.platformSupportSessions.find((candidate) => candidate.tokenHash === tokenHash && !candidate.releasedAt);
    if (!session) {
      throw unauthorized('Invalid or expired platform session.');
    }
    const admin = this.platformAdmins.find((candidate) => candidate.id === session.adminId);
    if (!admin) {
      throw unauthorized('Platform admin no longer exists.');
    }
    return { admin: { id: admin.id, email: admin.email } };
  }

  async resolvePlatformSupportSessionByToken(token: string): Promise<{ session: PlatformSupportSession }> {
    await this.ready;
    this.pruneExpiredPlatformSupportSessions();
    const tokenHash = await hashSecret(token);
    const session = this.platformSupportSessions.find(
      (candidate) => candidate.tokenHash === tokenHash && !candidate.releasedAt && candidate.reason !== 'platform-auth'
    );
    if (!session) {
      throw unauthorized('Invalid or expired support session.');
    }
    return { session };
  }

  async createPlatformSupportSession(input: { adminId: string; tenantId: string; reason: string; ttlMinutes?: number }): Promise<{ session: PlatformSupportSession; token: string }> {
    await this.ready;
    const tenantId = normalizeTenantId(input.tenantId);
    await this.getTenant(tenantId);
    const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? 60, 5), 8 * 60);
    const token = createAuthToken();
    const session: PlatformSupportSession = normalizePlatformSupportSessionRecord({
      id: `support_${crypto.randomUUID()}`,
      tokenHash: await hashSecret(token),
      adminId: input.adminId,
      tenantId,
      reason: input.reason.trim(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString()
    });
    this.platformSupportSessions = [session, ...this.platformSupportSessions];
    this.logSecurityEvent({
      actorType: 'platform_admin',
      actorId: input.adminId,
      action: 'platform.support.assume_tenant',
      tenantId,
      metadata: { reason: input.reason.trim(), ttlMinutes }
    });
    await this.persist();
    return { session, token };
  }

  async releasePlatformSupportSession(token: string, adminId: string): Promise<{ ok: true }> {
    await this.ready;
    const tokenHash = await hashSecret(token);
    const session = this.platformSupportSessions.find((candidate) => candidate.tokenHash === tokenHash && !candidate.releasedAt);
    if (!session) {
      throw unauthorized('Invalid or expired support session.');
    }
    if (session.adminId !== adminId) {
      throw forbidden('Support session belongs to another platform admin.');
    }
    const updated: PlatformSupportSession = normalizePlatformSupportSessionRecord({
      ...session,
      releasedAt: new Date().toISOString()
    });
    this.platformSupportSessions = this.platformSupportSessions.map((candidate) => (candidate.id === session.id ? updated : candidate));
    this.logSecurityEvent({
      actorType: 'platform_admin',
      actorId: adminId,
      action: 'platform.support.release_tenant',
      tenantId: session.tenantId,
      metadata: { sessionId: session.id }
    });
    await this.persist();
    return { ok: true };
  }

  async listPlatformSupportSessions(adminId: string): Promise<PlatformSupportSession[]> {
    await this.ready;
    this.pruneExpiredPlatformSupportSessions();
    return this.platformSupportSessions
      .filter((session) => session.adminId === adminId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listSecurityAuditLog(adminId: string): Promise<SecurityAuditLogEntry[]> {
    await this.ready;
    const exists = this.platformAdmins.some((candidate) => candidate.id === adminId);
    if (!exists) {
      throw forbidden('Only platform admins may view security audit log.');
    }
    return [...this.securityAuditLog].sort((left, right) => right.at.localeCompare(left.at));
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

  async signup(input: {
    email: string;
    password: string;
    displayName?: string;
    tenant: TenantRecordInput;
  }) {
    await this.ready;
    const email = normalizeEmail(input.email);
    if (this.users.some((candidate) => normalizeEmail(candidate.email) === email)) {
      throw conflict(`User with email ${email} already exists.`);
    }

    const now = new Date().toISOString();
    const user: StoredUser = normalizeStoredUserRecord({
      id: createUserId(email),
      email,
      displayName: input.displayName?.trim() || undefined,
      passwordHash: await hashSecret(input.password),
      createdAt: now,
      updatedAt: now
    });

    this.users = [...this.users, user];
    await this.persist();
    const { tenant } = await this.createTenant(input.tenant, user.id);
    const { session, token } = await this.createSession(user.id, tenant.id);
    const memberships = await this.listUserMemberships(user.id);
    return {
      user: stripUserSecret(user),
      session,
      token,
      activeTenantId: session.activeTenantId,
      memberships
    };
  }

  async login(input: { email: string; password: string; tenantId?: string }) {
    await this.ready;
    const email = normalizeEmail(input.email);
    const user = this.users.find((candidate) => normalizeEmail(candidate.email) === email);
    if (!user) {
      throw unauthorized('Invalid email or password.');
    }

    const passwordHash = await hashSecret(input.password);
    if (passwordHash !== user.passwordHash) {
      throw unauthorized('Invalid email or password.');
    }

    const memberships = await this.listUserMemberships(user.id);
    const activeMemberships = memberships.filter((membership) => membership.seatState === 'active');
    if (!activeMemberships.length) {
      throw forbidden(`User ${user.id} does not have an active seat in any tenant.`);
    }
    const requestedTenantId = input.tenantId ? normalizeTenantId(input.tenantId) : undefined;
    const activeTenantId = requestedTenantId ?? activeMemberships[0].tenantId;
    if (!activeMemberships.some((membership) => membership.tenantId === activeTenantId)) {
      throw forbidden(`User ${user.id} does not have an active seat in tenant ${activeTenantId}.`);
    }

    const { session, token } = await this.createSession(user.id, activeTenantId);
    return {
      user: stripUserSecret(user),
      session,
      token,
      activeTenantId: session.activeTenantId,
      memberships
    };
  }

  async resolveSessionByToken(token: string): Promise<{
    user: User;
    session: UserSession;
    memberships: TenantMember[];
  }> {
    await this.ready;
    this.pruneExpiredSessions();
    const tokenHash = await hashSecret(token);
    const session = this.userSessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session) {
      throw unauthorized('Invalid or expired auth session.');
    }
    const user = this.users.find((candidate) => candidate.id === session.userId);
    if (!user) {
      throw unauthorized('Auth session user no longer exists.');
    }
    const memberships = await this.listUserMemberships(user.id);
    const hasActiveTenantAccess = memberships.some((membership) => membership.tenantId === session.activeTenantId && membership.seatState === 'active');
    if (!hasActiveTenantAccess) {
      throw forbidden(`User ${session.userId} does not have an active seat in tenant ${session.activeTenantId}.`);
    }

    const touchedSession = {
      ...session,
      lastSeenAt: new Date().toISOString()
    };
    this.userSessions = this.userSessions.map((candidate) => (candidate.id === touchedSession.id ? touchedSession : candidate));
    await this.persist();
    return {
      user: stripUserSecret(user),
      session: touchedSession,
      memberships
    };
  }

  async setSessionActiveTenant(sessionId: string, tenantId: string): Promise<UserSession> {
    await this.ready;
    const normalizedTenantId = normalizeTenantId(tenantId);
    const session = this.userSessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw unauthorized('Invalid or expired auth session.');
    }
    const membership = await this.getTenantMembership(normalizedTenantId, session.userId);
    if (!membership || membership.seatState !== 'active') {
      throw forbidden(`User ${session.userId} does not have an active seat in tenant ${normalizedTenantId}.`);
    }

    const nextSession = normalizeUserSessionRecord({
      ...session,
      tenantId: normalizedTenantId,
      activeTenantId: normalizedTenantId,
      lastSeenAt: new Date().toISOString()
    });
    this.userSessions = this.userSessions.map((candidate) => (candidate.id === sessionId ? nextSession : candidate));
    await this.persist();
    return nextSession;
  }

  async logout(sessionId: string): Promise<{ ok: true }> {
    await this.ready;
    this.userSessions = this.userSessions.filter((session) => session.id !== sessionId);
    await this.persist();
    return { ok: true };
  }

  async getUserById(userId: string): Promise<User | undefined> {
    await this.ready;
    const user = this.users.find((candidate) => candidate.id === userId);
    return user ? stripUserSecret(user) : undefined;
  }

  async listUserMemberships(userId: string): Promise<TenantMember[]> {
    await this.ready;
    return [...this.tenantMemberships]
      .filter((membership) => membership.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
    const hasAutoReviewPatch = Object.prototype.hasOwnProperty.call(patch, 'autoReview');
    const hasSentinelConfigPatch = Object.prototype.hasOwnProperty.call(patch, 'sentinelConfig');
    const hasCheckpointConfigPatch = Object.prototype.hasOwnProperty.call(patch, 'checkpointConfig');
    const mergedAutoReview = hasAutoReviewPatch
      ? {
          ...(existing.autoReview ?? {
            enabled: false,
            provider: getAutoReviewProviderDefaultForScm(existing.scmProvider),
            postInline: false
          }),
          ...patch.autoReview
        }
      : existing.autoReview;
    const mergedSentinelConfig = hasSentinelConfigPatch
      ? {
          ...(existing.sentinelConfig ?? {}),
          ...patch.sentinelConfig,
          reviewGate: {
            ...(existing.sentinelConfig?.reviewGate ?? {}),
            ...(patch.sentinelConfig?.reviewGate ?? {})
          },
          mergePolicy: {
            ...(existing.sentinelConfig?.mergePolicy ?? {}),
            ...(patch.sentinelConfig?.mergePolicy ?? {})
          },
          conflictPolicy: {
            ...(existing.sentinelConfig?.conflictPolicy ?? {}),
            ...(patch.sentinelConfig?.conflictPolicy ?? {})
          }
        }
      : existing.sentinelConfig;
    const mergedCheckpointConfig = hasCheckpointConfigPatch
      ? {
          ...(existing.checkpointConfig ?? DEFAULT_REPO_CHECKPOINT_CONFIG),
          ...patch.checkpointConfig,
          contextNotes: {
            ...(existing.checkpointConfig?.contextNotes ?? DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes),
            ...(patch.checkpointConfig?.contextNotes ?? {})
          },
          reviewPrep: {
            ...(existing.checkpointConfig?.reviewPrep ?? DEFAULT_REPO_CHECKPOINT_CONFIG.reviewPrep),
            ...(patch.checkpointConfig?.reviewPrep ?? {})
          }
        }
      : existing.checkpointConfig;

    const updated = buildRepoRecord({
      ...existing,
      ...patch,
      autoReview: mergedAutoReview,
      sentinelConfig: mergedSentinelConfig,
      checkpointConfig: mergedCheckpointConfig,
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
    const tasks = slices
      .flatMap((slice) => slice.tasks)
      .filter((task) => !normalizedTenantId || normalizeTenantId(task.tenantId) === normalizedTenantId);
    const runs = slices
      .flatMap((slice) => slice.runs)
      .filter((run) => !normalizedTenantId || normalizeTenantId(run.tenantId) === normalizedTenantId);
    const runIds = new Set(runs.map((run) => run.runId));
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const logs = slices.flatMap((slice) => slice.logs).filter((log) => runIds.has(log.runId));
    const events = slices
      .flatMap((slice) => slice.events ?? [])
      .filter((event) =>
        !normalizedTenantId
        || (normalizeTenantId(event.tenantId) === normalizedTenantId && (runIds.has(event.runId) || taskIds.has(event.taskId)))
      );
    const commands = slices
      .flatMap((slice) => slice.commands ?? [])
      .filter((command) =>
        !normalizedTenantId
        || (normalizeTenantId(command.tenantId) === normalizedTenantId && runIds.has(command.runId))
      );

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

    const tenantIds = [...new Set(snapshot.repos.map((repo) => normalizeTenantId(repo.tenantId)))];
    await Promise.all(
      tenantIds.map(async (tenantId) => {
        await this.broadcast({ type: 'board.snapshot', payload: await this.getBoardSync('all', tenantId) }, undefined, tenantId);
      })
    );
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

  async notifyRepoEvent(event: BoardEvent & { repoId?: string; tenantId?: string }) {
    await this.ready;
    const tenantId = await this.resolveEventTenantId(event);
    if (!tenantId) {
      return;
    }
    const message = stringifyBoardEvent(event);
    for (const socket of this.ctx.getWebSockets(buildTenantAllScopeTag(tenantId))) {
      socket.send(message);
    }

    if (event.repoId) {
      for (const socket of this.ctx.getWebSockets(buildTenantRepoScopeTag(tenantId, event.repoId))) {
        socket.send(message);
      }
    }
  }

  private async handleWebSocket(repoId: string, tenantId: string) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    if (repoId !== 'all') {
      const repo = await this.getRepo(repoId);
      if (normalizeTenantId(repo.tenantId) !== normalizedTenantId) {
        throw forbidden(`Cross-tenant websocket access denied: repo ${repoId} belongs to tenant ${repo.tenantId}.`);
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tags = repoId === 'all'
      ? [buildTenantAllScopeTag(normalizedTenantId)]
      : [buildTenantRepoScopeTag(normalizedTenantId, repoId)];
    this.ctx.acceptWebSocket(server, tags);
    server.send(stringifyBoardEvent({ type: 'board.snapshot', payload: await this.getBoardSync(repoId, normalizedTenantId) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(event: BoardEvent, repoId?: string, tenantId?: string) {
    await this.notifyRepoEvent({ ...event, repoId, tenantId });
  }

  private async resolveEventTenantId(event: BoardEvent & { repoId?: string; tenantId?: string }) {
    if (event.tenantId) {
      return normalizeTenantId(event.tenantId);
    }
    switch (event.type) {
      case 'repo.updated':
        return normalizeTenantId(event.payload.repo.tenantId);
      case 'task.updated':
        return normalizeTenantId(event.payload.task.tenantId);
      case 'run.updated':
        return normalizeTenantId(event.payload.run.tenantId);
      case 'run.events_appended':
        if (event.payload.events[0]?.tenantId) {
          return normalizeTenantId(event.payload.events[0].tenantId);
        }
        break;
      case 'run.commands_upserted':
        if (event.payload.commands[0]?.tenantId) {
          return normalizeTenantId(event.payload.commands[0].tenantId);
        }
        break;
      default:
        break;
    }

    if (event.repoId) {
      const repo = this.repos.find((candidate) => candidate.repoId === event.repoId);
      return repo ? normalizeTenantId(repo.tenantId) : undefined;
    }

    return undefined;
  }

  private async persist() {
    await this.ctx.storage.put(REPOS_STORAGE_KEY, this.repos);
    await this.ctx.storage.put(SCM_CREDENTIALS_STORAGE_KEY, this.scmCredentials);
    await this.ctx.storage.put(TENANTS_STORAGE_KEY, this.tenants);
    await this.ctx.storage.put(TENANT_MEMBERSHIPS_STORAGE_KEY, this.tenantMemberships);
    await this.ctx.storage.put(USERS_STORAGE_KEY, this.users);
    await this.ctx.storage.put(USER_SESSIONS_STORAGE_KEY, this.userSessions);
    await this.ctx.storage.put(TENANT_INVITES_STORAGE_KEY, this.tenantInvites);
    await this.ctx.storage.put(PLATFORM_ADMINS_STORAGE_KEY, this.platformAdmins);
    await this.ctx.storage.put(PLATFORM_SUPPORT_SESSIONS_STORAGE_KEY, this.platformSupportSessions);
    await this.ctx.storage.put(SECURITY_AUDIT_LOG_STORAGE_KEY, this.securityAuditLog);
  }

  private ensureBootstrapTenantAndOwner() {
    const now = new Date().toISOString();
    if (!this.users.some((user) => user.id === SYSTEM_USER_ID)) {
      this.users = [
        normalizeStoredUserRecord({
          id: SYSTEM_USER_ID,
          email: 'system@minions.local',
          displayName: 'System User',
          passwordHash: 'system',
          createdAt: now,
          updatedAt: now
        }),
        ...this.users
      ];
    }
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

  private pruneExpiredSessions() {
    const now = Date.now();
    this.userSessions = this.userSessions.filter((session) => Date.parse(session.expiresAt) > now);
  }

  private pruneExpiredInvites() {
    const now = Date.now();
    this.tenantInvites = this.tenantInvites.map((invite) => {
      if (invite.status !== 'pending') {
        return invite;
      }
      if (Date.parse(invite.expiresAt) <= now) {
        return { ...invite, status: 'revoked', revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      }
      return invite;
    });
  }

  private pruneExpiredPlatformSupportSessions() {
    const now = Date.now();
    this.platformSupportSessions = this.platformSupportSessions.filter((session) => {
      if (session.releasedAt) {
        return false;
      }
      return Date.parse(session.expiresAt) > now;
    });
  }

  private logSecurityEvent(entry: Omit<SecurityAuditLogEntry, 'id' | 'at'>) {
    this.securityAuditLog = [
      {
        id: `audit_${crypto.randomUUID()}`,
        at: new Date().toISOString(),
        ...entry
      },
      ...this.securityAuditLog
    ].slice(0, 2_000);
  }

  private async ensureBootstrapPlatformAdmin() {
    const record = this.env as unknown as Record<string, unknown>;
    const email = typeof record.PLATFORM_ADMIN_EMAIL === 'string' ? record.PLATFORM_ADMIN_EMAIL.trim().toLowerCase() : '';
    const password = typeof record.PLATFORM_ADMIN_PASSWORD === 'string' ? record.PLATFORM_ADMIN_PASSWORD : '';
    if (!email || !password) {
      return;
    }
    if (this.platformAdmins.some((candidate) => normalizeEmail(candidate.email) === email)) {
      return;
    }
    const now = new Date().toISOString();
    this.platformAdmins = [
      normalizePlatformAdminRecord({
        id: `admin_${crypto.randomUUID()}`,
        email,
        passwordHash: await hashSecret(password),
        createdAt: now,
        updatedAt: now
      }),
      ...this.platformAdmins
    ];
  }

  private async createSession(userId: string, activeTenantId: string): Promise<{ session: UserSession; token: string }> {
    const now = Date.now();
    const token = createAuthToken();
    const session = normalizeUserSessionRecord({
      id: `sess_${crypto.randomUUID()}`,
      userId,
      tenantId: activeTenantId,
      activeTenantId,
      tokenHash: await hashSecret(token),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      lastSeenAt: new Date(now).toISOString()
    });
    this.userSessions = [...this.userSessions, session];
    await this.persist();
    return { session, token };
  }
}

function buildRepoRecord(input: CreateRepoInput | Repo): Repo {
  const autoReviewEnabled = input.autoReview?.enabled ?? false;
  const normalizedAutoReview = {
    enabled: autoReviewEnabled,
    provider: input.autoReview?.provider ?? (autoReviewEnabled ? getAutoReviewProviderDefaultForScm(input.scmProvider) : 'gitlab'),
    postInline: input.autoReview?.postInline ?? false,
    postingMode: input.autoReview?.postingMode ?? 'platform',
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
  const normalizedCheckpointConfig = normalizeRepoCheckpointConfig({
    checkpointConfig: {
      ...DEFAULT_REPO_CHECKPOINT_CONFIG,
      ...input.checkpointConfig,
      contextNotes: {
        ...DEFAULT_REPO_CHECKPOINT_CONFIG.contextNotes,
        ...(input.checkpointConfig?.contextNotes ?? {})
      },
      reviewPrep: {
        ...DEFAULT_REPO_CHECKPOINT_CONFIG.reviewPrep,
        ...(input.checkpointConfig?.reviewPrep ?? {})
      }
    }
  }).checkpointConfig;

  const normalized = normalizeRepo({
    ...input,
    repoId: 'repoId' in input ? input.repoId : '',
    defaultBranch: input.defaultBranch ?? 'main',
    baselineUrl: input.baselineUrl,
    enabled: input.enabled ?? true,
    autoReview: normalizedAutoReview,
    sentinelConfig: normalizedSentinelConfig,
    checkpointConfig: normalizedCheckpointConfig,
    llmAdapter: input.llmAdapter,
    llmAuthMode: input.llmAuthMode,
    llmProfileId: input.llmProfileId,
    githubAuthMode: 'githubAuthMode' in input ? input.githubAuthMode : undefined,
    previewMode: 'previewMode' in input ? input.previewMode : 'auto',
    evidenceMode: 'evidenceMode' in input ? input.evidenceMode : 'auto',
    previewAdapter: 'previewAdapter' in input ? input.previewAdapter : undefined,
    previewConfig: 'previewConfig' in input ? input.previewConfig : undefined,
    commitConfig: 'commitConfig' in input ? input.commitConfig : undefined,
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

function buildTenantAllScopeTag(tenantId: string) {
  return `scope:tenant:${normalizeTenantId(tenantId)}:all`;
}

function buildTenantRepoScopeTag(tenantId: string, repoId: string) {
  return `scope:tenant:${normalizeTenantId(tenantId)}:repo:${repoId}`;
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

function normalizeStoredUserRecord(user: StoredUser): StoredUser {
  return {
    ...user,
    id: user.id.trim(),
    email: normalizeEmail(user.email),
    displayName: user.displayName?.trim() || undefined,
    passwordHash: user.passwordHash.trim()
  };
}

function normalizeUserSessionRecord(session: UserSession): UserSession {
  return {
    ...session,
    id: session.id.trim(),
    userId: session.userId.trim(),
    tenantId: normalizeTenantId(session.tenantId),
    activeTenantId: normalizeTenantId(session.activeTenantId),
    tokenHash: session.tokenHash.trim()
  };
}

function normalizeTenantInviteRecord(invite: TenantInvite): TenantInvite {
  return {
    ...invite,
    id: invite.id.trim(),
    tenantId: normalizeTenantId(invite.tenantId),
    email: normalizeEmail(invite.email),
    role: invite.role === 'owner' ? 'owner' : 'member',
    status: invite.status === 'accepted' || invite.status === 'revoked' ? invite.status : 'pending',
    tokenHash: invite.tokenHash.trim(),
    createdByUserId: invite.createdByUserId.trim(),
    acceptedByUserId: invite.acceptedByUserId?.trim(),
    acceptedAt: invite.acceptedAt,
    revokedAt: invite.revokedAt,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt
  };
}

function normalizePlatformAdminRecord(admin: PlatformAdmin): PlatformAdmin {
  return {
    ...admin,
    id: admin.id.trim(),
    email: normalizeEmail(admin.email),
    passwordHash: admin.passwordHash.trim()
  };
}

function normalizePlatformSupportSessionRecord(session: PlatformSupportSession): PlatformSupportSession {
  return {
    ...session,
    id: session.id.trim(),
    tokenHash: session.tokenHash.trim(),
    adminId: session.adminId.trim(),
    tenantId: normalizeTenantId(session.tenantId),
    reason: session.reason.trim(),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    releasedAt: session.releasedAt
  };
}

function normalizeSecurityAuditLogEntry(entry: SecurityAuditLogEntry): SecurityAuditLogEntry {
  return {
    ...entry,
    id: entry.id.trim(),
    at: entry.at,
    actorType: entry.actorType === 'platform_admin' ? 'platform_admin' : 'tenant_user',
    actorId: entry.actorId.trim(),
    action: entry.action.trim(),
    tenantId: entry.tenantId ? normalizeTenantId(entry.tenantId) : undefined,
    metadata: entry.metadata
  };
}

function stripUserSecret(user: StoredUser): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw badRequest('Invalid email.');
  }
  return email;
}

function createUserId(email: string): string {
  const base = email.split('@')[0].replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return `${base}_${Math.random().toString(36).slice(2, 10)}`;
}

function createAuthToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashSecret(input: string): Promise<string> {
  const payload = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
