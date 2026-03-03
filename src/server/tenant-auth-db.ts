import type { Tenant, TenantMember, TenantSeatSummary, User, UserSession } from '../ui/domain/types';
import { badRequest, conflict, forbidden, notFound, unauthorized } from './http/errors';

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
  createdByUserId: string;
  acceptedByUserId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type PlatformSupportSession = {
  id: string;
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

type StoredUser = User & { passwordHash: string };
type PlatformAdmin = { id: string; email: string; passwordHash: string; createdAt: string; updatedAt: string };

const DEFAULT_SEAT_LIMIT = 5;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const PLATFORM_SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

let schemaReady: Promise<void> | undefined;

function getDb(env: Env): D1Database {
  const record = env as unknown as Record<string, unknown>;
  const candidates = ['TENANT_DB', 'APP_DB', 'DB', 'USAGE_DB', 'TENANT_USAGE_DB'];
  for (const name of candidates) {
    const candidate = record[name];
    if (candidate && typeof candidate === 'object' && 'prepare' in candidate && typeof (candidate as { prepare?: unknown }).prepare === 'function') {
      return candidate as D1Database;
    }
  }
  throw new Error('TENANT_DB binding is not configured.');
}

async function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        domain TEXT,
        created_by_user_id TEXT NOT NULL,
        default_seat_limit INTEGER NOT NULL,
        seat_limit INTEGER NOT NULL,
        settings_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_memberships (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        seat_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        active_tenant_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_invites (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        accepted_by_user_id TEXT,
        accepted_at TEXT,
        revoked_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_admins (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_support_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        admin_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE TABLE IF NOT EXISTS security_audit_log (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        tenant_id TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_user ON tenant_memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON tenant_memberships(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_invites_token ON tenant_invites(token_hash);
      CREATE INDEX IF NOT EXISTS idx_platform_sessions_token ON platform_support_sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_audit_at ON security_audit_log(at);
    `).then(() => undefined);
  }
  await schemaReady;
}

async function ensurePlatformAdmin(db: D1Database, env: Env): Promise<void> {
  const record = env as unknown as Record<string, unknown>;
  const email = typeof record.PLATFORM_ADMIN_EMAIL === 'string' ? normalizeEmail(record.PLATFORM_ADMIN_EMAIL) : '';
  const password = typeof record.PLATFORM_ADMIN_PASSWORD === 'string' ? record.PLATFORM_ADMIN_PASSWORD.trim() : '';
  if (!email || !password) {
    return;
  }
  const existing = await db.prepare('SELECT id FROM platform_admins WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>();
  if (existing) {
    return;
  }
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO platform_admins (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(`admin_${crypto.randomUUID()}`, email, await hashSecret(password), now, now).run();
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw badRequest('Invalid email.');
  }
  return email;
}

function normalizeTenantSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    throw badRequest('Invalid tenant slug.');
  }
  return slug;
}

function parseSettings(raw: string | null): Tenant['settings'] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function mapTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    status: row.status === 'suspended' ? 'suspended' : 'active',
    domain: row.domain ? String(row.domain) : undefined,
    createdByUserId: String(row.created_by_user_id),
    defaultSeatLimit: Number(row.default_seat_limit) || DEFAULT_SEAT_LIMIT,
    seatLimit: Number(row.seat_limit) || DEFAULT_SEAT_LIMIT,
    settings: parseSettings((row.settings_json as string | null) ?? null),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapMember(row: Record<string, unknown>): TenantMember {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    role: row.role === 'owner' ? 'owner' : 'member',
    seatState: row.seat_state === 'invited' || row.seat_state === 'revoked' ? row.seat_state : 'active',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: row.display_name ? String(row.display_name) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapStoredUser(row: Record<string, unknown>): StoredUser {
  return {
    ...mapUser(row),
    passwordHash: String(row.password_hash)
  };
}

function mapSession(row: Record<string, unknown>): UserSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tenantId: String(row.active_tenant_id),
    activeTenantId: String(row.active_tenant_id),
    tokenHash: String(row.token_hash),
    expiresAt: String(row.expires_at),
    lastSeenAt: String(row.last_seen_at)
  };
}

async function hashSecret(input: string): Promise<string> {
  const payload = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createAuthToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createUserId(email: string): string {
  const base = email.split('@')[0].replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return `${base}_${Math.random().toString(36).slice(2, 10)}`;
}

function createTenantId(slug: string): string {
  return `tenant_${slug}`;
}

function createTenantMemberId(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

async function writeAuditLog(db: D1Database, entry: Omit<SecurityAuditLogEntry, 'id' | 'at'>): Promise<void> {
  await db.prepare(
    'INSERT INTO security_audit_log (id, at, actor_type, actor_id, action, tenant_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    `audit_${crypto.randomUUID()}`,
    new Date().toISOString(),
    entry.actorType,
    entry.actorId,
    entry.action,
    entry.tenantId ?? null,
    entry.metadata ? JSON.stringify(entry.metadata) : null
  ).run();
}

export async function signup(env: Env, input: {
  email: string;
  password: string;
  displayName?: string;
  tenant: TenantRecordInput;
}) {
  const db = getDb(env);
  await ensureSchema(db);
  await ensurePlatformAdmin(db, env);
  const email = normalizeEmail(input.email);
  const existing = await db.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>();
  if (existing) {
    throw conflict(`User with email ${email} already exists.`);
  }
  const slug = normalizeTenantSlug(input.tenant.slug);
  const existingTenant = await db.prepare('SELECT id FROM tenants WHERE slug = ? LIMIT 1').bind(slug).first<{ id: string }>();
  if (existingTenant) {
    throw conflict(`Tenant slug ${slug} already exists.`);
  }

  const now = new Date().toISOString();
  const userId = createUserId(email);
  const tenantId = createTenantId(slug);
  const seatLimit = input.tenant.seatLimit ?? input.tenant.defaultSeatLimit ?? DEFAULT_SEAT_LIMIT;
  const defaultSeatLimit = input.tenant.defaultSeatLimit ?? input.tenant.seatLimit ?? DEFAULT_SEAT_LIMIT;
  await db.batch([
    db.prepare(
      'INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(userId, email, input.displayName?.trim() || null, await hashSecret(input.password), now, now),
    db.prepare(
      'INSERT INTO tenants (id, slug, name, status, domain, created_by_user_id, default_seat_limit, seat_limit, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(tenantId, slug, input.tenant.name.trim(), 'active', input.tenant.domain?.trim() || null, userId, defaultSeatLimit, seatLimit, null, now, now),
    db.prepare(
      'INSERT INTO tenant_memberships (id, tenant_id, user_id, role, seat_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(createTenantMemberId(tenantId, userId), tenantId, userId, 'owner', 'active', now, now)
  ]);
  return login(env, { email, password: input.password, tenantId });
}

export async function login(env: Env, input: { email: string; password: string; tenantId?: string }) {
  const db = getDb(env);
  await ensureSchema(db);
  await ensurePlatformAdmin(db, env);
  const email = normalizeEmail(input.email);
  const userRow = await db.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email).first<Record<string, unknown>>();
  if (!userRow) {
    throw unauthorized('Invalid email or password.');
  }
  const user = mapStoredUser(userRow);
  if (user.passwordHash !== await hashSecret(input.password)) {
    throw unauthorized('Invalid email or password.');
  }

  const memberships = await listUserMemberships(env, user.id);
  const activeMemberships = memberships.filter((membership) => membership.seatState === 'active');
  if (!activeMemberships.length) {
    throw forbidden(`User ${user.id} does not have an active seat in any tenant.`);
  }
  const activeTenantId = input.tenantId?.trim() || activeMemberships[0].tenantId;
  if (!activeMemberships.some((membership) => membership.tenantId === activeTenantId)) {
    throw forbidden(`User ${user.id} does not have an active seat in tenant ${activeTenantId}.`);
  }

  const now = Date.now();
  const token = createAuthToken();
  const tokenHash = await hashSecret(token);
  const session: UserSession = {
    id: `sess_${crypto.randomUUID()}`,
    userId: user.id,
    tenantId: activeTenantId,
    activeTenantId,
    tokenHash,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  };
  await db.prepare(
    'INSERT INTO user_sessions (id, user_id, active_tenant_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(session.id, session.userId, session.activeTenantId, session.tokenHash, session.expiresAt, session.lastSeenAt).run();

  return {
    user: stripUserSecret(user),
    session,
    token,
    activeTenantId: session.activeTenantId,
    memberships
  };
}

export async function resolveSessionByToken(env: Env, token: string): Promise<{ user: User; session: UserSession; memberships: TenantMember[] }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const sessionRow = await db.prepare(
    'SELECT * FROM user_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1'
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!sessionRow) {
    throw unauthorized('Invalid or expired auth session.');
  }
  const session = mapSession(sessionRow);
  const userRow = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(session.userId).first<Record<string, unknown>>();
  if (!userRow) {
    throw unauthorized('Auth session user no longer exists.');
  }
  const memberships = await listUserMemberships(env, session.userId);
  if (!memberships.some((membership) => membership.tenantId === session.activeTenantId && membership.seatState === 'active')) {
    throw forbidden(`User ${session.userId} does not have an active seat in tenant ${session.activeTenantId}.`);
  }
  const touchedAt = new Date().toISOString();
  await db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').bind(touchedAt, session.id).run();
  return {
    user: mapUser(userRow),
    session: { ...session, lastSeenAt: touchedAt },
    memberships
  };
}

export async function setSessionActiveTenant(env: Env, sessionId: string, tenantId: string): Promise<UserSession> {
  const db = getDb(env);
  await ensureSchema(db);
  const sessionRow = await db.prepare('SELECT * FROM user_sessions WHERE id = ? LIMIT 1').bind(sessionId).first<Record<string, unknown>>();
  if (!sessionRow) {
    throw unauthorized('Invalid or expired auth session.');
  }
  const session = mapSession(sessionRow);
  const membership = await getTenantMembership(env, tenantId, session.userId);
  if (!membership || membership.seatState !== 'active') {
    throw forbidden(`User ${session.userId} does not have an active seat in tenant ${tenantId}.`);
  }
  const lastSeenAt = new Date().toISOString();
  await db.prepare('UPDATE user_sessions SET active_tenant_id = ?, last_seen_at = ? WHERE id = ?').bind(tenantId, lastSeenAt, sessionId).run();
  return { ...session, tenantId, activeTenantId: tenantId, lastSeenAt };
}

export async function logout(env: Env, sessionId: string): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  await db.prepare('DELETE FROM user_sessions WHERE id = ?').bind(sessionId).run();
  return { ok: true };
}

export async function getUserById(env: Env, userId: string): Promise<User | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>();
  return row ? mapUser(row) : undefined;
}

export async function listUserMemberships(env: Env, userId: string): Promise<TenantMember[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const result = await db.prepare('SELECT * FROM tenant_memberships WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapMember);
}

export async function listTenantsForUser(env: Env, userId: string): Promise<Tenant[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const result = await db.prepare(
    `SELECT t.* FROM tenants t
     INNER JOIN tenant_memberships m ON m.tenant_id = t.id
     WHERE m.user_id = ? AND m.seat_state = 'active'
     ORDER BY t.slug ASC`
  ).bind(userId).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapTenant);
}

export async function getTenant(env: Env, tenantId: string): Promise<Tenant> {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM tenants WHERE id = ? LIMIT 1').bind(tenantId.trim()).first<Record<string, unknown>>();
  if (!row) {
    throw notFound(`Tenant ${tenantId} not found.`);
  }
  return mapTenant(row);
}

export async function getTenantMembership(env: Env, tenantId: string, userId: string): Promise<TenantMember | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1').bind(tenantId.trim(), userId.trim()).first<Record<string, unknown>>();
  return row ? mapMember(row) : undefined;
}

export async function hasActiveTenantAccess(env: Env, tenantId: string, userId: string): Promise<boolean> {
  const membership = await getTenantMembership(env, tenantId, userId);
  return Boolean(membership && membership.seatState === 'active');
}

export async function listTenantMembers(env: Env, tenantId: string): Promise<TenantMember[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const result = await db.prepare('SELECT * FROM tenant_memberships WHERE tenant_id = ? ORDER BY created_at ASC').bind(tenantId).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapMember);
}

export async function getTenantSeatSummary(env: Env, tenantId: string): Promise<TenantSeatSummary> {
  const db = getDb(env);
  const tenant = await getTenant(env, tenantId);
  const row = await db.prepare(
    "SELECT COUNT(*) AS seats_used FROM tenant_memberships WHERE tenant_id = ? AND seat_state = 'active'"
  ).bind(tenant.id).first<{ seats_used: number }>();
  const seatsUsed = Number(row?.seats_used ?? 0);
  return {
    tenantId: tenant.id,
    seatLimit: tenant.seatLimit,
    seatsUsed,
    seatsAvailable: Math.max(0, tenant.seatLimit - seatsUsed)
  };
}

async function assertOwnerAccess(env: Env, tenantId: string, userId: string) {
  const membership = await getTenantMembership(env, tenantId, userId);
  if (!membership || membership.seatState !== 'active') {
    throw forbidden(`User ${userId} does not have an active seat in tenant ${tenantId}.`);
  }
  if (membership.role !== 'owner') {
    throw forbidden(`User ${userId} must be an owner of tenant ${tenantId}.`);
  }
}

async function assertSeatCapacity(env: Env, tenantId: string) {
  const summary = await getTenantSeatSummary(env, tenantId);
  if (summary.seatsUsed >= summary.seatLimit) {
    throw conflict(`Tenant ${tenantId} has no available seats.`);
  }
}

export async function createTenant(env: Env, input: TenantRecordInput, actorUserId: string): Promise<{ tenant: Tenant; ownerMembership: TenantMember; seatSummary: TenantSeatSummary }> {
  const db = getDb(env);
  await ensureSchema(db);
  const slug = normalizeTenantSlug(input.slug);
  const existing = await db.prepare('SELECT id FROM tenants WHERE slug = ? LIMIT 1').bind(slug).first<{ id: string }>();
  if (existing) {
    throw conflict(`Tenant slug ${slug} already exists.`);
  }
  const now = new Date().toISOString();
  const tenantId = createTenantId(slug);
  const seatLimit = input.seatLimit ?? input.defaultSeatLimit ?? DEFAULT_SEAT_LIMIT;
  const defaultSeatLimit = input.defaultSeatLimit ?? input.seatLimit ?? DEFAULT_SEAT_LIMIT;
  const membership: TenantMember = {
    id: createTenantMemberId(tenantId, actorUserId),
    tenantId,
    userId: actorUserId,
    role: 'owner',
    seatState: 'active',
    createdAt: now,
    updatedAt: now
  };
  await db.batch([
    db.prepare(
      'INSERT INTO tenants (id, slug, name, status, domain, created_by_user_id, default_seat_limit, seat_limit, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(tenantId, slug, input.name.trim(), 'active', input.domain?.trim() || null, actorUserId, defaultSeatLimit, seatLimit, null, now, now),
    db.prepare(
      'INSERT INTO tenant_memberships (id, tenant_id, user_id, role, seat_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(membership.id, membership.tenantId, membership.userId, membership.role, membership.seatState, membership.createdAt, membership.updatedAt)
  ]);
  return {
    tenant: await getTenant(env, tenantId),
    ownerMembership: membership,
    seatSummary: await getTenantSeatSummary(env, tenantId)
  };
}

export async function createTenantMember(env: Env, tenantId: string, input: TenantMemberRecordInput, actorUserId: string): Promise<{ member: TenantMember; seatSummary: TenantSeatSummary }> {
  const db = getDb(env);
  await ensureSchema(db);
  await assertOwnerAccess(env, tenantId, actorUserId);
  const existing = await getTenantMembership(env, tenantId, input.userId);
  if (existing) {
    throw conflict(`Member ${input.userId} already exists in tenant ${tenantId}.`);
  }
  const seatState = input.seatState ?? 'active';
  if (seatState === 'active') {
    await assertSeatCapacity(env, tenantId);
  }
  const now = new Date().toISOString();
  const member: TenantMember = {
    id: createTenantMemberId(tenantId, input.userId),
    tenantId,
    userId: input.userId,
    role: input.role ?? 'member',
    seatState,
    createdAt: now,
    updatedAt: now
  };
  await db.prepare(
    'INSERT INTO tenant_memberships (id, tenant_id, user_id, role, seat_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(member.id, member.tenantId, member.userId, member.role, member.seatState, member.createdAt, member.updatedAt).run();
  return { member, seatSummary: await getTenantSeatSummary(env, tenantId) };
}

export async function updateTenantMember(
  env: Env,
  tenantId: string,
  memberId: string,
  patch: Pick<TenantMemberRecordInput, 'role' | 'seatState'>,
  actorUserId: string
): Promise<{ member: TenantMember; seatSummary: TenantSeatSummary }> {
  const db = getDb(env);
  await ensureSchema(db);
  await assertOwnerAccess(env, tenantId, actorUserId);
  const row = await db.prepare('SELECT * FROM tenant_memberships WHERE tenant_id = ? AND id = ? LIMIT 1').bind(tenantId, memberId).first<Record<string, unknown>>();
  if (!row) {
    throw notFound(`Member ${memberId} not found in tenant ${tenantId}.`);
  }
  const existing = mapMember(row);
  const nextSeatState = patch.seatState ?? existing.seatState;
  if (existing.seatState !== 'active' && nextSeatState === 'active') {
    await assertSeatCapacity(env, tenantId);
  }
  const nextRole = patch.role ?? existing.role;
  if (existing.role === 'owner' && (nextRole !== 'owner' || nextSeatState !== 'active')) {
    const ownersRow = await db.prepare(
      "SELECT COUNT(*) AS owners FROM tenant_memberships WHERE tenant_id = ? AND id <> ? AND role = 'owner' AND seat_state = 'active'"
    ).bind(tenantId, memberId).first<{ owners: number }>();
    if (Number(ownersRow?.owners ?? 0) === 0) {
      throw forbidden(`Tenant ${tenantId} requires at least one active owner.`);
    }
  }
  const updatedAt = new Date().toISOString();
  await db.prepare('UPDATE tenant_memberships SET role = ?, seat_state = ?, updated_at = ? WHERE id = ?').bind(nextRole, nextSeatState, updatedAt, memberId).run();
  return {
    member: {
      ...existing,
      role: nextRole,
      seatState: nextSeatState,
      updatedAt
    },
    seatSummary: await getTenantSeatSummary(env, tenantId)
  };
}

export async function createTenantInvite(
  env: Env,
  tenantId: string,
  input: { email: string; role?: TenantMember['role'] },
  actorUserId: string
): Promise<{ invite: Omit<TenantInvite, 'tokenHash'>; token: string; seatSummary: TenantSeatSummary }> {
  const db = getDb(env);
  await ensureSchema(db);
  await assertOwnerAccess(env, tenantId, actorUserId);
  const email = normalizeEmail(input.email);
  const pending = await db.prepare(
    "SELECT id FROM tenant_invites WHERE tenant_id = ? AND email = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).bind(tenantId, email, new Date().toISOString()).first<{ id: string }>();
  if (pending) {
    throw conflict(`Pending invite for ${email} already exists in tenant ${tenantId}.`);
  }
  const role = input.role ?? 'member';
  if (role === 'owner') {
    await assertSeatCapacity(env, tenantId);
  }
  const now = new Date().toISOString();
  const token = createAuthToken();
  const invite: TenantInvite = {
    id: `invite_${crypto.randomUUID()}`,
    tenantId,
    email,
    role,
    status: 'pending',
    createdByUserId: actorUserId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    createdAt: now,
    updatedAt: now
  };
  await db.prepare(
    `INSERT INTO tenant_invites
     (id, tenant_id, email, role, status, token_hash, created_by_user_id, accepted_by_user_id, accepted_at, revoked_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
  ).bind(invite.id, invite.tenantId, invite.email, invite.role, invite.status, await hashSecret(token), invite.createdByUserId, invite.expiresAt, invite.createdAt, invite.updatedAt).run();
  await writeAuditLog(db, {
    actorType: 'tenant_user',
    actorId: actorUserId,
    action: 'tenant.invite.created',
    tenantId,
    metadata: { inviteId: invite.id, email: invite.email, role: invite.role }
  });
  return { invite, token, seatSummary: await getTenantSeatSummary(env, tenantId) };
}

export async function listTenantInvites(env: Env, tenantId: string, actorUserId: string): Promise<Array<Omit<TenantInvite, 'tokenHash'>>> {
  const db = getDb(env);
  await ensureSchema(db);
  await assertOwnerAccess(env, tenantId, actorUserId);
  const result = await db.prepare(
    'SELECT id, tenant_id, email, role, status, created_by_user_id, accepted_by_user_id, accepted_at, revoked_at, expires_at, created_at, updated_at FROM tenant_invites WHERE tenant_id = ? ORDER BY created_at DESC'
  ).bind(tenantId).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    email: String(row.email),
    role: row.role === 'owner' ? 'owner' : 'member',
    status: row.status === 'accepted' || row.status === 'revoked' ? row.status : 'pending',
    createdByUserId: String(row.created_by_user_id),
    acceptedByUserId: row.accepted_by_user_id ? String(row.accepted_by_user_id) : undefined,
    acceptedAt: row.accepted_at ? String(row.accepted_at) : undefined,
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }));
}

export async function resolvePendingTenantInviteByToken(
  env: Env,
  token: string
): Promise<{ invite: Omit<TenantInvite, 'tokenHash'> }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT id, tenant_id, email, role, status, created_by_user_id, accepted_by_user_id, accepted_at, revoked_at, expires_at, created_at, updated_at FROM tenant_invites WHERE token_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired invite.');
  }
  return {
    invite: {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      email: String(row.email),
      role: row.role === 'owner' ? 'owner' : 'member',
      status: 'pending',
      createdByUserId: String(row.created_by_user_id),
      acceptedByUserId: row.accepted_by_user_id ? String(row.accepted_by_user_id) : undefined,
      acceptedAt: row.accepted_at ? String(row.accepted_at) : undefined,
      revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  };
}

export async function acceptTenantInvite(env: Env, token: string, actorUserId: string): Promise<{ membership: TenantMember; invite: Omit<TenantInvite, 'tokenHash'> }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT * FROM tenant_invites WHERE token_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired invite.');
  }
  const invite: TenantInvite = {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    email: String(row.email),
    role: row.role === 'owner' ? 'owner' : 'member',
    status: 'pending',
    createdByUserId: String(row.created_by_user_id),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  const user = await getUserById(env, actorUserId);
  if (!user || normalizeEmail(user.email) !== invite.email) {
    throw forbidden('Invite email does not match authenticated user.');
  }
  const existingMembership = await getTenantMembership(env, invite.tenantId, actorUserId);
  if (existingMembership && existingMembership.seatState === 'active') {
    throw conflict(`User ${actorUserId} already has an active seat in tenant ${invite.tenantId}.`);
  }
  await assertSeatCapacity(env, invite.tenantId);
  const now = new Date().toISOString();
  const membership: TenantMember = {
    id: createTenantMemberId(invite.tenantId, actorUserId),
    tenantId: invite.tenantId,
    userId: actorUserId,
    role: invite.role,
    seatState: 'active',
    createdAt: existingMembership?.createdAt ?? now,
    updatedAt: now
  };
  if (existingMembership) {
    await db.prepare(
      'UPDATE tenant_memberships SET role = ?, seat_state = ?, updated_at = ? WHERE id = ?'
    ).bind(membership.role, membership.seatState, membership.updatedAt, existingMembership.id).run();
  } else {
    await db.prepare(
      'INSERT INTO tenant_memberships (id, tenant_id, user_id, role, seat_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(membership.id, membership.tenantId, membership.userId, membership.role, membership.seatState, membership.createdAt, membership.updatedAt).run();
  }
  await db.prepare(
    "UPDATE tenant_invites SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ? WHERE id = ?"
  ).bind(actorUserId, now, now, invite.id).run();
  await writeAuditLog(db, {
    actorType: 'tenant_user',
    actorId: actorUserId,
    action: 'tenant.invite.accepted',
    tenantId: invite.tenantId,
    metadata: { inviteId: invite.id, membershipId: membership.id }
  });
  return { membership, invite: { ...invite, status: 'accepted', acceptedByUserId: actorUserId, acceptedAt: now, updatedAt: now } };
}

function stripUserSecret(user: StoredUser): User {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

function mapPlatformSession(row: Record<string, unknown>): PlatformSupportSession {
  return {
    id: String(row.id),
    adminId: String(row.admin_id),
    tenantId: String(row.tenant_id),
    reason: String(row.reason),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    releasedAt: row.released_at ? String(row.released_at) : undefined
  };
}

function mapPlatformAdmin(row: Record<string, unknown>): PlatformAdmin {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function platformLogin(env: Env, input: { email: string; password: string }) {
  const db = getDb(env);
  await ensureSchema(db);
  await ensurePlatformAdmin(db, env);
  const email = normalizeEmail(input.email);
  const row = await db.prepare('SELECT * FROM platform_admins WHERE email = ? LIMIT 1').bind(email).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid platform admin credentials.');
  }
  const admin = mapPlatformAdmin(row);
  if (admin.passwordHash !== await hashSecret(input.password)) {
    throw unauthorized('Invalid platform admin credentials.');
  }
  const token = createAuthToken();
  const sessionId = `psess_${crypto.randomUUID()}`;
  await db.prepare(
    'INSERT INTO platform_support_sessions (id, token_hash, admin_id, tenant_id, reason, created_at, expires_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
  ).bind(
    sessionId,
    await hashSecret(token),
    admin.id,
    '__platform__',
    'platform-auth',
    new Date().toISOString(),
    new Date(Date.now() + PLATFORM_SESSION_TTL_MS).toISOString()
  ).run();
  await writeAuditLog(db, { actorType: 'platform_admin', actorId: admin.id, action: 'platform.auth.login' });
  return { admin: { id: admin.id, email: admin.email }, token };
}

export async function resolvePlatformAdminByToken(env: Env, token: string): Promise<{ admin: { id: string; email: string } }> {
  const db = getDb(env);
  await ensureSchema(db);
  await ensurePlatformAdmin(db, env);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT p.* FROM platform_support_sessions s INNER JOIN platform_admins p ON p.id = s.admin_id WHERE s.token_hash = ? AND s.reason = 'platform-auth' AND s.released_at IS NULL AND s.expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired platform session.');
  }
  return { admin: { id: String(row.id), email: String(row.email) } };
}

export async function createPlatformSupportSession(
  env: Env,
  input: { adminId: string; tenantId: string; reason: string; ttlMinutes?: number }
): Promise<{ session: PlatformSupportSession; token: string }> {
  const db = getDb(env);
  await ensureSchema(db);
  await getTenant(env, input.tenantId);
  const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? 60, 5), 8 * 60);
  const token = createAuthToken();
  const session: PlatformSupportSession = {
    id: `support_${crypto.randomUUID()}`,
    adminId: input.adminId,
    tenantId: input.tenantId.trim(),
    reason: input.reason.trim(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString()
  };
  await db.prepare(
    'INSERT INTO platform_support_sessions (id, token_hash, admin_id, tenant_id, reason, created_at, expires_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
  ).bind(session.id, await hashSecret(token), session.adminId, session.tenantId, session.reason, session.createdAt, session.expiresAt).run();
  await writeAuditLog(db, {
    actorType: 'platform_admin',
    actorId: input.adminId,
    action: 'platform.support.assume_tenant',
    tenantId: session.tenantId,
    metadata: { reason: session.reason, ttlMinutes }
  });
  return { session, token };
}

export async function resolvePlatformSupportSessionByToken(env: Env, token: string): Promise<{ session: PlatformSupportSession }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT * FROM platform_support_sessions WHERE token_hash = ? AND reason <> 'platform-auth' AND released_at IS NULL AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired support session.');
  }
  return { session: mapPlatformSession(row) };
}

export async function releasePlatformSupportSession(env: Env, token: string, adminId: string): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT * FROM platform_support_sessions WHERE token_hash = ? AND reason <> 'platform-auth' AND released_at IS NULL AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired support session.');
  }
  const session = mapPlatformSession(row);
  if (session.adminId !== adminId) {
    throw forbidden('Support session belongs to another platform admin.');
  }
  const releasedAt = new Date().toISOString();
  await db.prepare('UPDATE platform_support_sessions SET released_at = ? WHERE id = ?').bind(releasedAt, session.id).run();
  await writeAuditLog(db, {
    actorType: 'platform_admin',
    actorId: adminId,
    action: 'platform.support.release_tenant',
    tenantId: session.tenantId,
    metadata: { sessionId: session.id }
  });
  return { ok: true };
}

export async function listPlatformSupportSessions(env: Env, adminId: string): Promise<PlatformSupportSession[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const result = await db.prepare(
    'SELECT * FROM platform_support_sessions WHERE admin_id = ? ORDER BY created_at DESC'
  ).bind(adminId).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapPlatformSession);
}

export async function listSecurityAuditLog(env: Env, adminId: string): Promise<SecurityAuditLogEntry[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const admin = await db.prepare('SELECT id FROM platform_admins WHERE id = ? LIMIT 1').bind(adminId).first<{ id: string }>();
  if (!admin) {
    throw forbidden('Only platform admins may view security audit log.');
  }
  const result = await db.prepare('SELECT * FROM security_audit_log ORDER BY at DESC LIMIT 500').all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    at: String(row.at),
    actorType: row.actor_type === 'platform_admin' ? 'platform_admin' : 'tenant_user',
    actorId: String(row.actor_id),
    action: String(row.action),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    metadata: (() => {
      if (!row.metadata_json || typeof row.metadata_json !== 'string') {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.metadata_json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return undefined;
        }
        const out: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[k] = v;
          }
        }
        return Object.keys(out).length ? out : undefined;
      } catch {
        return undefined;
      }
    })()
  }));
}
