import type {
  IntegrationConfig,
  IntegrationConfigSettings,
  IntegrationPluginKind,
  IntegrationScopeType,
  JiraProjectRepoMapping,
  SlackThreadBinding,
  Tenant,
  TenantMember,
  TenantSeatSummary,
  User,
  UserSession
} from '../ui/domain/types';
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

type IntegrationConfigInput = {
  tenantId: string;
  scopeType: IntegrationScopeType;
  scopeId?: string;
  pluginKind: IntegrationPluginKind;
  enabled?: boolean;
  settings?: IntegrationConfigSettings;
  secretRef?: string;
};

type JiraProjectRepoMappingInput = {
  tenantId: string;
  jiraProjectKey: string;
  repoId: string;
  priority?: number;
  active?: boolean;
};

type SlackThreadBindingInput = {
  tenantId: string;
  taskId: string;
  channelId: string;
  threadTs: string;
  currentRunId?: string;
  latestReviewRound?: number;
};

const DEFAULT_SEAT_LIMIT = 100;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SINGLE_TENANT_FALLBACK_ID = 'tenant_local';
const DEFAULT_INTEGRATION_PRIORITY = 0;
const DEFAULT_INTEGRATION_LATEST_REVIEW_ROUND = 0;
const PASSWORD_HASH_SCHEME = 'pbkdf2_sha256';
const PASSWORD_HASH_ITERATIONS = 210_000;
const PASSWORD_SALT_BYTES = 16;

const VALID_INTEGRATION_SCOPE_TYPES = new Set<IntegrationScopeType>(['tenant', 'repo', 'channel']);
const VALID_INTEGRATION_PLUGIN_KINDS = new Set<IntegrationPluginKind>(['slack', 'jira', 'gitlab']);

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
        'user_api_tokens',
        'integration_configs',
        'jira_project_repo_mappings',
        'slack_thread_bindings'
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

function parseIntegrationBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }

  return false;
}

function parseSettingsJson(value: unknown): IntegrationConfigSettings {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return {};
    }
    const settings = parsed as Record<string, unknown>;
    const sanitized: IntegrationConfigSettings = {};
    for (const [key, raw] of Object.entries(settings)) {
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        sanitized[key] = raw;
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function parseScopeType(value: unknown): IntegrationScopeType {
  const candidate = String(value ?? '').trim();
  if (VALID_INTEGRATION_SCOPE_TYPES.has(candidate as IntegrationScopeType)) {
    return candidate as IntegrationScopeType;
  }
  throw badRequest('Invalid integration config scope type.');
}

function parsePluginKind(value: unknown): IntegrationPluginKind {
  const candidate = String(value ?? '').trim();
  if (VALID_INTEGRATION_PLUGIN_KINDS.has(candidate as IntegrationPluginKind)) {
    return candidate as IntegrationPluginKind;
  }
  throw badRequest('Invalid integration plugin kind.');
}

function mapIntegrationConfig(row: Record<string, unknown>): IntegrationConfig {
  return {
    id: externalId(row),
    tenantId: String(row.tenant_id),
    scopeType: parseScopeType(row.scope_type),
    scopeId: row.scope_type === 'tenant' || row.scope_id === '' ? undefined : String(row.scope_id),
    pluginKind: parsePluginKind(row.plugin_kind),
    enabled: parseIntegrationBoolean(row.enabled),
    settings: parseSettingsJson(row.settings_json),
    secretRef: row.secret_ref ? String(row.secret_ref) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapJiraProjectRepoMapping(row: Record<string, unknown>): JiraProjectRepoMapping {
  return {
    id: externalId(row),
    tenantId: String(row.tenant_id),
    jiraProjectKey: String(row.jira_project_key),
    repoId: String(row.repo_id),
    priority: Number(row.priority ?? DEFAULT_INTEGRATION_PRIORITY),
    active: parseIntegrationBoolean(row.active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapSlackThreadBinding(row: Record<string, unknown>): SlackThreadBinding {
  return {
    id: externalId(row),
    tenantId: String(row.tenant_id),
    taskId: String(row.task_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    currentRunId: row.current_run_id ? String(row.current_run_id) : undefined,
    latestReviewRound: Number(row.latest_review_round ?? DEFAULT_INTEGRATION_LATEST_REVIEW_ROUND),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeIntegrationScope(scopeType: IntegrationScopeType, scopeId: string | undefined): string {
  if (scopeType === 'tenant') {
    return '';
  }
  if (!scopeId?.trim()) {
    throw badRequest(`integration scope ${scopeType} requires scopeId.`);
  }
  if (scopeId.includes(':')) {
    throw badRequest(`integration scopeId cannot contain ":" for scope ${scopeType}.`);
  }
  return scopeId.trim();
}

function normalizeIntegrationInput(input: IntegrationConfigInput): IntegrationConfigInput {
  if (!VALID_INTEGRATION_SCOPE_TYPES.has(input.scopeType)) {
    throw badRequest('Invalid integration scope type.');
  }
  if (!VALID_INTEGRATION_PLUGIN_KINDS.has(input.pluginKind)) {
    throw badRequest('Invalid integration plugin kind.');
  }
  const scopeId = normalizeIntegrationScope(input.scopeType, input.scopeId);
  return {
    tenantId: input.tenantId,
    scopeType: input.scopeType,
    scopeId,
    pluginKind: input.pluginKind,
    enabled: input.enabled ?? true,
    settings: input.settings ?? {},
    secretRef: input.secretRef
  };
}

function normalizeMappingInput(input: JiraProjectRepoMappingInput): JiraProjectRepoMappingInput {
  const jiraProjectKey = input.jiraProjectKey.trim().toUpperCase();
  if (!jiraProjectKey) {
    throw badRequest('jiraProjectKey is required.');
  }
  const repoId = input.repoId.trim();
  if (!repoId) {
    throw badRequest('repoId is required.');
  }
  return {
    tenantId: input.tenantId,
    jiraProjectKey,
    repoId,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
    active: input.active ?? true
  };
}

function normalizeSlackBindingInput(input: SlackThreadBindingInput): SlackThreadBindingInput {
  const taskId = input.taskId.trim();
  const channelId = input.channelId.trim();
  const threadTs = input.threadTs.trim();
  if (!taskId || !channelId || !threadTs) {
    throw badRequest('taskId, channelId and threadTs are required.');
  }
  return {
    tenantId: input.tenantId,
    taskId,
    channelId,
    threadTs,
    currentRunId: input.currentRunId?.trim(),
    latestReviewRound: Number.isFinite(input.latestReviewRound) ? input.latestReviewRound : 0
  };
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

function hexToByteValues(hex: string): number[] {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex input.');
  }
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    const value = Number.parseInt(hex.slice(index, index + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error('Invalid hex input.');
    }
    bytes.push(value);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function createRandomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return bytesToHex(values);
}

async function derivePasswordHash(password: string, saltHex: string, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: Uint8Array.from(hexToByteValues(saltHex)),
      iterations
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function parsePasswordHash(hash: string): { iterations: number; saltHex: string; digestHex: string } | undefined {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_SCHEME) {
    return undefined;
  }
  const iterations = Number.parseInt(parts[1] ?? '', 10);
  const saltHex = parts[2] ?? '';
  const digestHex = parts[3] ?? '';
  if (
    !Number.isInteger(iterations)
    || iterations < 1
    || !/^[a-f0-9]+$/i.test(saltHex)
    || saltHex.length < 2
    || saltHex.length % 2 !== 0
    || !/^[a-f0-9]{64}$/i.test(digestHex)
  ) {
    return undefined;
  }
  return { iterations, saltHex: saltHex.toLowerCase(), digestHex: digestHex.toLowerCase() };
}

function isLegacySha256Hash(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

async function hashPassword(password: string): Promise<string> {
  const saltHex = createRandomHex(PASSWORD_SALT_BYTES);
  const digestHex = await derivePasswordHash(password, saltHex, PASSWORD_HASH_ITERATIONS);
  return `${PASSWORD_HASH_SCHEME}$${PASSWORD_HASH_ITERATIONS}$${saltHex}$${digestHex}`;
}

async function verifyPassword(password: string, passwordHash: string): Promise<{ valid: boolean; upgradedHash?: string }> {
  const parsed = parsePasswordHash(passwordHash);
  if (parsed) {
    const computed = await derivePasswordHash(password, parsed.saltHex, parsed.iterations);
    return { valid: timingSafeEqual(computed, parsed.digestHex) };
  }

  if (!isLegacySha256Hash(passwordHash)) {
    return { valid: false };
  }

  const legacyHash = await hashSecret(password);
  if (!timingSafeEqual(legacyHash, passwordHash.toLowerCase())) {
    return { valid: false };
  }

  return { valid: true, upgradedHash: await hashPassword(password) };
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

function buildIntegrationConfigRowId() {
  return `integration_config_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`;
}

function buildJiraProjectRepoMappingRowId() {
  return `jira_mapping_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`;
}

function buildSlackThreadBindingRowId() {
  return `thread_binding_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`;
}

export async function upsertIntegrationConfig(env: Env, input: IntegrationConfigInput): Promise<IntegrationConfig> {
  const db = getDb(env);
  await ensureSchema(db);
  const normalized = normalizeIntegrationInput(input);
  const now = new Date().toISOString();
  const id = buildIntegrationConfigRowId();
  await db.prepare(
    `INSERT INTO integration_configs
     (external_id, tenant_id, scope_type, scope_id, plugin_kind, enabled, settings_json, secret_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, scope_type, scope_id, plugin_kind) DO UPDATE SET
       enabled = excluded.enabled,
       settings_json = excluded.settings_json,
       secret_ref = excluded.secret_ref,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    normalized.tenantId,
    normalized.scopeType,
    normalized.scopeId ?? null,
    normalized.pluginKind,
    normalized.enabled ? 1 : 0,
    JSON.stringify(normalized.settings ?? {}),
    normalized.secretRef ?? null,
    now,
    now
  ).run();
  const selected = await getIntegrationConfig(env, {
    tenantId: normalized.tenantId,
    pluginKind: normalized.pluginKind,
    scopeType: normalized.scopeType,
    scopeId: normalized.scopeId
  });
  if (!selected) {
    throw badRequest('Failed to persist integration configuration.');
  }
  return selected;
}

export async function getIntegrationConfig(
  env: Env,
  input: {
    tenantId: string;
    pluginKind: IntegrationPluginKind;
    scopeType: IntegrationScopeType;
    scopeId?: string;
  }
): Promise<IntegrationConfig | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  const scopeId = normalizeIntegrationScope(input.scopeType, input.scopeId);
  const statement = await db
    .prepare('SELECT * FROM integration_configs WHERE tenant_id = ? AND plugin_kind = ? AND scope_type = ? AND scope_id = ? LIMIT 1')
    .bind(input.tenantId, input.pluginKind, input.scopeType, scopeId)
    .first<Record<string, unknown>>();
  if (!statement) {
    return undefined;
  }
  return mapIntegrationConfig(statement);
}

export async function listIntegrationConfigs(
  env: Env,
  tenantId: string,
  filters?: {
    pluginKind?: IntegrationPluginKind;
    scopeType?: IntegrationScopeType;
    scopeId?: string;
    enabledOnly?: boolean;
  }
): Promise<IntegrationConfig[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const clauses: string[] = ['tenant_id = ?'];
  const values: unknown[] = [tenantId];
  if (filters?.pluginKind) {
    clauses.push('plugin_kind = ?');
    values.push(filters.pluginKind);
  }
  if (filters?.scopeType) {
    clauses.push('scope_type = ?');
    values.push(filters.scopeType);
  }
  if (filters?.scopeType && filters.scopeType !== 'tenant' && filters.scopeId) {
    clauses.push('scope_id = ?');
    values.push(filters.scopeId);
  }
  if (filters?.enabledOnly) {
    clauses.push('enabled = 1');
  }

  const query = `SELECT * FROM integration_configs WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`;
  const result = await db.prepare(query).bind(...values).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapIntegrationConfig);
}

export async function deleteIntegrationConfig(
  env: Env,
  tenantId: string,
  configId: string
): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  await db.prepare('DELETE FROM integration_configs WHERE tenant_id = ? AND external_id = ?').bind(tenantId, configId).run();
  return { ok: true };
}

export async function upsertJiraProjectRepoMapping(
  env: Env,
  input: JiraProjectRepoMappingInput
): Promise<JiraProjectRepoMapping> {
  const db = getDb(env);
  await ensureSchema(db);
  const normalized = normalizeMappingInput(input);
  const now = new Date().toISOString();
  const id = buildJiraProjectRepoMappingRowId();
  await db.prepare(
    `INSERT INTO jira_project_repo_mappings
     (external_id, tenant_id, jira_project_key, repo_id, priority, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, jira_project_key, repo_id) DO UPDATE SET
       priority = excluded.priority,
       active = excluded.active,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    normalized.tenantId,
    normalized.jiraProjectKey,
    normalized.repoId,
    normalized.priority,
    normalized.active ? 1 : 0,
    now,
    now
  ).run();
  const rows = await db.prepare(
    `SELECT * FROM jira_project_repo_mappings WHERE tenant_id = ? AND jira_project_key = ? AND repo_id = ? LIMIT 1`
  ).bind(normalized.tenantId, normalized.jiraProjectKey, normalized.repoId).all<Record<string, unknown>>();
  const found = (rows.results ?? [])[0];
  if (!found) {
    throw badRequest('Failed to persist Jira-to-repo mapping.');
  }
  return mapJiraProjectRepoMapping(found);
}

export async function listJiraProjectRepoMappings(
  env: Env,
  tenantId: string,
  filters?: { jiraProjectKey?: string; activeOnly?: boolean; repoId?: string }
): Promise<JiraProjectRepoMapping[]> {
  const db = getDb(env);
  await ensureSchema(db);
  const clauses = ['tenant_id = ?'];
  const values: unknown[] = [tenantId];
  if (filters?.jiraProjectKey) {
    clauses.push('jira_project_key = ?');
    values.push(filters.jiraProjectKey.toUpperCase());
  }
  if (filters?.repoId) {
    clauses.push('repo_id = ?');
    values.push(filters.repoId);
  }
  if (filters?.activeOnly) {
    clauses.push('active = 1');
  }
  const query = `SELECT * FROM jira_project_repo_mappings WHERE ${clauses.join(' AND ')} ORDER BY priority ASC, updated_at DESC`;
  const result = await db.prepare(query).bind(...values).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapJiraProjectRepoMapping);
}

export async function listJiraProjectRepoMappingsByProject(
  env: Env,
  tenantId: string,
  jiraProjectKey: string,
  activeOnly = false
): Promise<JiraProjectRepoMapping[]> {
  return listJiraProjectRepoMappings(env, tenantId, { jiraProjectKey, activeOnly });
}

export async function deleteJiraProjectRepoMapping(env: Env, tenantId: string, mappingId: string): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  await db.prepare('DELETE FROM jira_project_repo_mappings WHERE tenant_id = ? AND external_id = ?').bind(tenantId, mappingId).run();
  return { ok: true };
}

export async function upsertSlackThreadBinding(
  env: Env,
  input: SlackThreadBindingInput
): Promise<SlackThreadBinding> {
  const db = getDb(env);
  await ensureSchema(db);
  const normalized = normalizeSlackBindingInput(input);
  const now = new Date().toISOString();
  const id = buildSlackThreadBindingRowId();
  await db.prepare(
    `INSERT INTO slack_thread_bindings
     (external_id, tenant_id, task_id, channel_id, thread_ts, current_run_id, latest_review_round, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, task_id, channel_id) DO UPDATE SET
       thread_ts = excluded.thread_ts,
       current_run_id = excluded.current_run_id,
       latest_review_round = excluded.latest_review_round,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    normalized.tenantId,
    normalized.taskId,
    normalized.channelId,
    normalized.threadTs,
    normalized.currentRunId ?? null,
    normalized.latestReviewRound,
    now,
    now
  ).run();
  const rows = await db.prepare(
    `SELECT * FROM slack_thread_bindings WHERE tenant_id = ? AND task_id = ? AND channel_id = ? LIMIT 1`
  ).bind(normalized.tenantId, normalized.taskId, normalized.channelId).all<Record<string, unknown>>();
  const found = (rows.results ?? [])[0];
  if (!found) {
    throw badRequest('Failed to persist slack thread binding.');
  }
  return mapSlackThreadBinding(found);
}

export async function getSlackThreadBinding(
  env: Env,
  tenantId: string,
  taskId: string,
  channelId: string
): Promise<SlackThreadBinding | undefined> {
  const db = getDb(env);
  await ensureSchema(db);
  const result = await db.prepare(
    'SELECT * FROM slack_thread_bindings WHERE tenant_id = ? AND task_id = ? AND channel_id = ? LIMIT 1'
  ).bind(tenantId, taskId.trim(), channelId.trim()).first<Record<string, unknown>>();
  if (!result) {
    return undefined;
  }
  return mapSlackThreadBinding(result);
}

export async function deleteSlackThreadBinding(
  env: Env,
  tenantId: string,
  taskId: string,
  channelId: string
): Promise<{ ok: true }> {
  const db = getDb(env);
  await ensureSchema(db);
  await db.prepare(
    'DELETE FROM slack_thread_bindings WHERE tenant_id = ? AND task_id = ? AND channel_id = ?'
  ).bind(tenantId, taskId.trim(), channelId.trim()).run();
  return { ok: true };
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
  ).bind(userId, email, input.displayName?.trim() || null, role, await hashPassword(input.password), now, now).run();

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
  const passwordVerification = await verifyPassword(input.password, user.passwordHash);
  if (!passwordVerification.valid) {
    throw unauthorized('Invalid email or password.');
  }
  if (passwordVerification.upgradedHash) {
    await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE external_id = ?')
      .bind(passwordVerification.upgradedHash, new Date().toISOString(), user.id)
      .run();
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
