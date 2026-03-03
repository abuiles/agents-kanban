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
  actorType: 'tenant_user';
  actorId: string;
  action: string;
  tenantId?: string;
  metadata?: Record<string, string | number | boolean>;
};

type StoredUser = User & { role: 'owner' | 'member'; passwordHash: string };

type UserApiTokenRecord = {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

const DEFAULT_SEAT_LIMIT = 100;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SINGLE_TENANT_FALLBACK_ID = 'tenant_local';

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
    schemaReady = (async () => {
      const requiredTables = [
        'app_tenant_config',
        'users',
        'user_sessions',
        'invites',
        'user_api_tokens'
      ] as const;
      const quoted = requiredTables.map((table) => `'${table}'`).join(', ');
      const result = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quoted})`).all<{ name: string }>();
      const found = new Set((result.results ?? []).map((row) => String(row.name)));
      const missing = requiredTables.filter((table) => !found.has(table));
      if (missing.length > 0) {
        throw new Error(
          `TENANT_DB schema is missing required tables (${missing.join(', ')}). Apply D1 migrations (npx wrangler d1 migrations apply TENANT_DB).`
        );
      }
    })();
  }
  await schemaReady;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw badRequest('Invalid email.');
  }
  return email;
}

function externalId(row: Record<string, unknown>): string {
  return String(row.external_id ?? row.id);
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: externalId(row),
    email: String(row.email),
    displayName: row.display_name ? String(row.display_name) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapStoredUser(row: Record<string, unknown>): StoredUser {
  return {
    ...mapUser(row),
    role: row.role === 'owner' ? 'owner' : 'member',
    passwordHash: String(row.password_hash)
  };
}

async function mapSession(row: Record<string, unknown>, tenantId: string): Promise<UserSession> {
  return {
    id: externalId(row),
    userId: String(row.user_id),
    tenantId,
    activeTenantId: tenantId,
    tokenHash: String(row.token_hash),
    expiresAt: String(row.expires_at),
    lastSeenAt: String(row.last_seen_at)
  };
}

function mapTenant(tenantId: string, row: Record<string, unknown>): Tenant {
  const seatLimit = Number(row.seat_limit ?? DEFAULT_SEAT_LIMIT) || DEFAULT_SEAT_LIMIT;
  return {
    id: tenantId,
    slug: String(row.slug ?? 'local'),
    name: String(row.name ?? 'Local deployment'),
    status: row.status === 'suspended' ? 'suspended' : 'active',
    domain: row.domain ? String(row.domain) : undefined,
    createdByUserId: String(row.created_by_user_id ?? 'system'),
    defaultSeatLimit: seatLimit,
    seatLimit,
    settings: undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapInvite(row: Record<string, unknown>, tenantId: string): TenantInvite {
  return {
    id: externalId(row),
    tenantId,
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
  };
}

function parseScopes(scopes: unknown): string[] {
  if (typeof scopes !== 'string' || !scopes) {
    return [];
  }
  try {
    const parsed = JSON.parse(scopes);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  } catch {
    return [];
  }
}

function mapApiToken(row: Record<string, unknown>): UserApiTokenRecord {
  return {
    id: externalId(row),
    userId: String(row.user_id),
    name: String(row.name),
    scopes: parseScopes(row.scopes_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : undefined,
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined
  };
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

async function hashSecret(input: string): Promise<string> {
  const payload = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stripUserSecret(user: StoredUser): User {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

async function getTenantConfigRow(db: D1Database): Promise<Record<string, unknown>> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM app_tenant_config LIMIT 1').first<Record<string, unknown>>();
  if (!row) {
    throw new Error('app_tenant_config is empty. Seed one row before starting the app.');
  }
  return row;
}

async function getTenantId(db: D1Database): Promise<string> {
  const row = await getTenantConfigRow(db);
  const value = row.external_id ? String(row.external_id).trim() : '';
  return value || SINGLE_TENANT_FALLBACK_ID;
}

async function ensureTenantIdMatch(db: D1Database, tenantId: string): Promise<string> {
  const canonical = await getTenantId(db);
  if (tenantId.trim() !== canonical) {
    throw forbidden(`Tenant ${tenantId} is not available in single-tenant mode.`);
  }
  return canonical;
}

async function membershipForUser(env: Env, userId: string): Promise<TenantMember | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM users WHERE external_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>();
  if (!row) {
    return undefined;
  }
  const tenantId = await getTenantId(db);
  const now = String(row.updated_at ?? row.created_at ?? new Date().toISOString());
  return {
    id: `${tenantId}:${externalId(row)}`,
    tenantId,
    userId: externalId(row),
    role: row.role === 'owner' ? 'owner' : 'member',
    seatState: 'active',
    createdAt: String(row.created_at ?? now),
    updatedAt: now
  };
}

async function assertOwner(env: Env, userId: string) {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT role FROM users WHERE external_id = ? LIMIT 1').bind(userId).first<{ role: string }>();
  if (!row || row.role !== 'owner') {
    throw forbidden('Only owner users may perform this action.');
  }
}

async function writeAuditLog(
  db: D1Database,
  entry: Omit<SecurityAuditLogEntry, 'id' | 'at'>
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO security_audit_log (external_id, at, actor_type, actor_id, action, tenant_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    `audit_${crypto.randomUUID()}`,
    now,
    'tenant_user',
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
  tenant: Omit<TenantRecordInput, 'slug'>;
}) {
  const db = getDb(env);
  await ensureSchema(db);
  const email = normalizeEmail(input.email);
  const existing = await db.prepare('SELECT external_id FROM users WHERE email = ? LIMIT 1').bind(email).first<{ external_id: string }>();
  if (existing) {
    throw conflict(`User with email ${email} already exists.`);
  }

  const countRow = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
  const role: 'owner' | 'member' = Number(countRow?.count ?? 0) === 0 ? 'owner' : 'member';
  const now = new Date().toISOString();
  const userId = createUserId(email);

  await db.prepare(
    'INSERT INTO users (external_id, email, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, email, input.displayName?.trim() || null, role, await hashSecret(input.password), now, now).run();

  return login(env, { email, password: input.password });
}

export async function login(env: Env, input: { email: string; password: string; tenantId?: string }) {
  const db = getDb(env);
  await ensureSchema(db);
  const email = normalizeEmail(input.email);
  const userRow = await db.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email).first<Record<string, unknown>>();
  if (!userRow) {
    throw unauthorized('Invalid email or password.');
  }
  const user = mapStoredUser(userRow);
  if (user.passwordHash !== await hashSecret(input.password)) {
    throw unauthorized('Invalid email or password.');
  }

  const tenantId = await getTenantId(db);
  if (input.tenantId && input.tenantId.trim() !== tenantId) {
    throw forbidden(`Tenant ${input.tenantId} is not available in single-tenant mode.`);
  }

  const now = Date.now();
  const token = createAuthToken();
  const tokenHash = await hashSecret(token);
  const session: UserSession = {
    id: `sess_${crypto.randomUUID()}`,
    userId: user.id,
    tenantId,
    activeTenantId: tenantId,
    tokenHash,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  };
  await db.prepare(
    'INSERT INTO user_sessions (external_id, user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(session.id, session.userId, session.tokenHash, session.expiresAt, session.lastSeenAt).run();

  const membership = await membershipForUser(env, user.id);
  return {
    user: stripUserSecret(user),
    session,
    token,
    activeTenantId: tenantId,
    memberships: membership ? [membership] : []
  };
}

export async function resolveSessionByToken(env: Env, token: string): Promise<{ user: User; session: UserSession; memberships: TenantMember[] }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    'SELECT * FROM user_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1'
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired auth session.');
  }

  const tenantId = await getTenantId(db);
  const session = await mapSession(row, tenantId);
  const userRow = await db.prepare('SELECT * FROM users WHERE external_id = ? LIMIT 1').bind(session.userId).first<Record<string, unknown>>();
  if (!userRow) {
    throw unauthorized('Auth session user no longer exists.');
  }

  const touchedAt = new Date().toISOString();
  await db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE external_id = ?').bind(touchedAt, session.id).run();
  const membership = await membershipForUser(env, session.userId);
  return {
    user: mapUser(userRow),
    session: { ...session, lastSeenAt: touchedAt },
    memberships: membership ? [membership] : []
  };
}

export async function setSessionActiveTenant(env: Env, sessionId: string, tenantId: string): Promise<UserSession> {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM user_sessions WHERE external_id = ? LIMIT 1').bind(sessionId).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired auth session.');
  }
  const canonicalTenantId = await ensureTenantIdMatch(db, tenantId);
  const lastSeenAt = new Date().toISOString();
  await db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE external_id = ?').bind(lastSeenAt, sessionId).run();
  return {
    ...(await mapSession(row, canonicalTenantId)),
    tenantId: canonicalTenantId,
    activeTenantId: canonicalTenantId,
    lastSeenAt
  };
}

export async function logout(env: Env, sessionId: string): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  await db.prepare('DELETE FROM user_sessions WHERE external_id = ?').bind(sessionId).run();
  return { ok: true };
}

export async function getUserById(env: Env, userId: string): Promise<User | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM users WHERE external_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>();
  return row ? mapUser(row) : undefined;
}

export async function listUserMemberships(env: Env, userId: string): Promise<TenantMember[]> {
  const membership = await membershipForUser(env, userId);
  return membership ? [membership] : [];
}

export async function listTenantsForUser(env: Env, userId: string): Promise<Tenant[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const user = await db.prepare('SELECT external_id FROM users WHERE external_id = ? LIMIT 1').bind(userId).first<{ external_id: string }>();
  if (!user) {
    return [];
  }
  const tenantRow = await getTenantConfigRow(db);
  return [mapTenant(await getTenantId(db), tenantRow)];
}

export async function getTenant(env: Env, tenantId: string): Promise<Tenant> {
  const db = getDb(env);
  await ensureSchema(db);
  const canonical = await ensureTenantIdMatch(db, tenantId);
  return mapTenant(canonical, await getTenantConfigRow(db));
}

export async function getTenantMembership(env: Env, tenantId: string, userId: string): Promise<TenantMember | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  await ensureTenantIdMatch(db, tenantId);
  return membershipForUser(env, userId);
}

export async function hasActiveTenantAccess(env: Env, tenantId: string, userId: string): Promise<boolean> {
  const membership = await getTenantMembership(env, tenantId, userId);
  return Boolean(membership && membership.seatState === 'active');
}

export async function listTenantMembers(env: Env, tenantId: string): Promise<TenantMember[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const canonical = await ensureTenantIdMatch(db, tenantId);
  const result = await db.prepare('SELECT * FROM users ORDER BY created_at ASC').all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    id: `${canonical}:${externalId(row)}`,
    tenantId: canonical,
    userId: externalId(row),
    role: row.role === 'owner' ? 'owner' : 'member',
    seatState: 'active',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }));
}

export async function getTenantSeatSummary(env: Env, tenantId: string): Promise<TenantSeatSummary> {
  const db = getDb(env);
  await ensureSchema(db);
  const canonical = await ensureTenantIdMatch(db, tenantId);
  const tenantRow = await getTenantConfigRow(db);
  const seatLimit = Number(tenantRow.seat_limit ?? DEFAULT_SEAT_LIMIT) || DEFAULT_SEAT_LIMIT;
  const row = await db.prepare('SELECT COUNT(*) AS seats_used FROM users').first<{ seats_used: number }>();
  const seatsUsed = Number(row?.seats_used ?? 0);
  return {
    tenantId: canonical,
    seatLimit,
    seatsUsed,
    seatsAvailable: Math.max(0, seatLimit - seatsUsed)
  };
}

export async function createTenant(env: Env, input: TenantRecordInput, actorUserId: string): Promise<{ tenant: Tenant; ownerMembership: TenantMember; seatSummary: TenantSeatSummary }> {
  void input;
  void actorUserId;
  throw forbidden('Single-tenant mode does not allow creating additional tenants.');
}

export async function createTenantMember(env: Env, tenantId: string, input: TenantMemberRecordInput, actorUserId: string): Promise<{ member: TenantMember; seatSummary: TenantSeatSummary }> {
  void input;
  await assertOwner(env, actorUserId);
  await ensureTenantIdMatch(getDb(env), tenantId);
  throw forbidden('Direct tenant membership management is not supported in single-tenant mode. Use invites instead.');
}

export async function updateTenantMember(
  env: Env,
  tenantId: string,
  memberId: string,
  patch: Pick<TenantMemberRecordInput, 'role' | 'seatState'>,
  actorUserId: string
): Promise<{ member: TenantMember; seatSummary: TenantSeatSummary }> {
  void memberId;
  void patch;
  await assertOwner(env, actorUserId);
  await ensureTenantIdMatch(getDb(env), tenantId);
  throw forbidden('Direct tenant membership updates are not supported in single-tenant mode.');
}

export async function createTenantInvite(
  env: Env,
  tenantId: string,
  input: { email: string; role?: TenantMember['role'] },
  actorUserId: string
): Promise<{ invite: Omit<TenantInvite, 'tokenHash'>; token: string; seatSummary: TenantSeatSummary }> {
  const db = getDb(env);
  await ensureSchema(db);
  const canonicalTenantId = await ensureTenantIdMatch(db, tenantId);
  await assertOwner(env, actorUserId);

  const email = normalizeEmail(input.email);
  const nowIso = new Date().toISOString();
  const pending = await db.prepare(
    "SELECT external_id FROM invites WHERE email = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).bind(email, nowIso).first<{ external_id: string }>();
  if (pending) {
    throw conflict(`Pending invite for ${email} already exists.`);
  }

  const token = createAuthToken();
  const now = new Date().toISOString();
  const invite: TenantInvite = {
    id: `invite_${crypto.randomUUID()}`,
    tenantId: canonicalTenantId,
    email,
    role: input.role === 'owner' ? 'owner' : 'member',
    status: 'pending',
    createdByUserId: actorUserId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    createdAt: now,
    updatedAt: now
  };

  await db.prepare(
    `INSERT INTO invites
     (external_id, email, role, status, token_hash, created_by_user_id, accepted_by_user_id, accepted_at, revoked_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
  ).bind(invite.id, invite.email, invite.role, invite.status, await hashSecret(token), invite.createdByUserId, invite.expiresAt, invite.createdAt, invite.updatedAt).run();

  await writeAuditLog(db, {
    actorType: 'tenant_user',
    actorId: actorUserId,
    action: 'invite.created',
    tenantId: canonicalTenantId,
    metadata: { inviteId: invite.id, email: invite.email, role: invite.role }
  });

  return { invite, token, seatSummary: await getTenantSeatSummary(env, canonicalTenantId) };
}

export async function listTenantInvites(env: Env, tenantId: string, actorUserId: string): Promise<Array<Omit<TenantInvite, 'tokenHash'>>> {
  const db = getDb(env);
  await ensureSchema(db);
  const canonicalTenantId = await ensureTenantIdMatch(db, tenantId);
  await assertOwner(env, actorUserId);

  const result = await db.prepare(
    'SELECT * FROM invites ORDER BY created_at DESC'
  ).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => mapInvite(row, canonicalTenantId));
}

export async function resolvePendingTenantInviteByToken(
  env: Env,
  token: string
): Promise<{ invite: Omit<TenantInvite, 'tokenHash'> }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT * FROM invites WHERE token_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired invite.');
  }

  return { invite: mapInvite(row, await getTenantId(db)) };
}

export async function acceptTenantInvite(env: Env, token: string, actorUserId: string): Promise<{ membership: TenantMember; invite: Omit<TenantInvite, 'tokenHash'> }> {
  const db = getDb(env);
  await ensureSchema(db);
  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    "SELECT * FROM invites WHERE token_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired invite.');
  }

  const tenantId = await getTenantId(db);
  const invite = mapInvite(row, tenantId);
  const userRow = await db.prepare('SELECT * FROM users WHERE external_id = ? LIMIT 1').bind(actorUserId).first<Record<string, unknown>>();
  if (!userRow) {
    throw unauthorized('Authenticated user not found.');
  }
  const user = mapUser(userRow);
  if (normalizeEmail(user.email) !== invite.email) {
    throw forbidden('Invite email does not match authenticated user.');
  }

  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE external_id = ?').bind(invite.role, now, actorUserId),
    db.prepare("UPDATE invites SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ? WHERE external_id = ?")
      .bind(actorUserId, now, now, invite.id)
  ]);

  const membership: TenantMember = {
    id: `${tenantId}:${actorUserId}`,
    tenantId,
    userId: actorUserId,
    role: invite.role,
    seatState: 'active',
    createdAt: user.createdAt,
    updatedAt: now
  };

  await writeAuditLog(db, {
    actorType: 'tenant_user',
    actorId: actorUserId,
    action: 'invite.accepted',
    tenantId,
    metadata: { inviteId: invite.id, userId: actorUserId, role: invite.role }
  });

  return { membership, invite: { ...invite, status: 'accepted', acceptedByUserId: actorUserId, acceptedAt: now, updatedAt: now } };
}

export async function createUserApiToken(
  env: Env,
  actorUserId: string,
  input: { name: string; scopes?: string[]; expiresAt?: string }
): Promise<{ tokenRecord: UserApiTokenRecord; token: string }> {
  const db = getDb(env);
  await ensureSchema(db);
  const user = await db.prepare('SELECT external_id FROM users WHERE external_id = ? LIMIT 1').bind(actorUserId).first<{ external_id: string }>();
  if (!user) {
    throw unauthorized('User not found.');
  }

  const name = input.name.trim();
  if (!name) {
    throw badRequest('API token name is required.');
  }
  const scopes = (input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean);

  const token = createAuthToken();
  const now = new Date().toISOString();
  const tokenRecord: UserApiTokenRecord = {
    id: `pat_${crypto.randomUUID()}`,
    userId: actorUserId,
    name,
    scopes,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt?.trim() || undefined,
    lastUsedAt: undefined,
    revokedAt: undefined
  };

  await db.prepare(
    `INSERT INTO user_api_tokens
     (external_id, user_id, name, scopes_json, token_hash, expires_at, last_used_at, revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  ).bind(
    tokenRecord.id,
    tokenRecord.userId,
    tokenRecord.name,
    JSON.stringify(tokenRecord.scopes),
    await hashSecret(token),
    tokenRecord.expiresAt ?? null,
    tokenRecord.createdAt,
    tokenRecord.updatedAt
  ).run();

  return { tokenRecord, token };
}

export async function listUserApiTokens(env: Env, actorUserId: string): Promise<UserApiTokenRecord[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const result = await db.prepare(
    'SELECT * FROM user_api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
  ).bind(actorUserId).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapApiToken);
}

export async function revokeUserApiToken(env: Env, actorUserId: string, tokenId: string): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  const token = await db.prepare('SELECT * FROM user_api_tokens WHERE external_id = ? LIMIT 1').bind(tokenId).first<Record<string, unknown>>();
  if (!token || String(token.user_id) !== actorUserId) {
    throw notFound(`API token ${tokenId} not found.`);
  }
  await db.prepare('UPDATE user_api_tokens SET revoked_at = ?, updated_at = ? WHERE external_id = ?')
    .bind(new Date().toISOString(), new Date().toISOString(), tokenId)
    .run();
  return { ok: true };
}

export async function resolveApiToken(env: Env, token: string): Promise<{ user: User; tokenRecord: UserApiTokenRecord }> {
  const db = getDb(env);
  await ensureSchema(db);

  const tokenHash = await hashSecret(token);
  const row = await db.prepare(
    'SELECT * FROM user_api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1'
  ).bind(tokenHash, new Date().toISOString()).first<Record<string, unknown>>();
  if (!row) {
    throw unauthorized('Invalid or expired API token.');
  }

  const userRow = await db.prepare('SELECT * FROM users WHERE external_id = ? LIMIT 1').bind(String(row.user_id)).first<Record<string, unknown>>();
  if (!userRow) {
    throw unauthorized('API token user no longer exists.');
  }

  const now = new Date().toISOString();
  await db.prepare('UPDATE user_api_tokens SET last_used_at = ?, updated_at = ? WHERE external_id = ?')
    .bind(now, now, externalId(row))
    .run();

  return {
    user: mapUser(userRow),
    tokenRecord: { ...mapApiToken(row), lastUsedAt: now, updatedAt: now }
  };
}

export async function platformLogin(env: Env, input: { email: string; password: string }) {
  void env;
  void input;
  throw forbidden('Platform admin authentication is removed in single-tenant mode.');
}

export async function resolvePlatformAdminByToken(env: Env, token: string): Promise<{ admin: { id: string; email: string } }> {
  void env;
  void token;
  throw forbidden('Platform admin authentication is removed in single-tenant mode.');
}

export async function createPlatformSupportSession(
  env: Env,
  input: { adminId: string; tenantId: string; reason: string; ttlMinutes?: number }
): Promise<{ session: PlatformSupportSession; token: string }> {
  void env;
  void input;
  throw forbidden('Platform support sessions are removed in single-tenant mode.');
}

export async function resolvePlatformSupportSessionByToken(env: Env, token: string): Promise<{ session: PlatformSupportSession }> {
  void env;
  void token;
  throw forbidden('Platform support sessions are removed in single-tenant mode.');
}

export async function releasePlatformSupportSession(env: Env, token: string, adminId: string): Promise<{ ok: true }> {
  void env;
  void token;
  void adminId;
  throw forbidden('Platform support sessions are removed in single-tenant mode.');
}

export async function listPlatformSupportSessions(env: Env, adminId: string): Promise<PlatformSupportSession[]> {
  void env;
  void adminId;
  return [];
}

export async function listSecurityAuditLog(env: Env, adminId: string): Promise<SecurityAuditLogEntry[]> {
  void env;
  void adminId;
  return [];
}
