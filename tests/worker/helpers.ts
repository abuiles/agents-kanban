import { env } from 'cloudflare:test';

const TENANT_ID = 'tenant_local';

const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS app_tenant_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    external_id TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    domain TEXT,
    created_by_user_id TEXT,
    seat_limit INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
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
  )`,
  `CREATE TABLE IF NOT EXISTS user_api_tokens (
    id INTEGER PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    scopes_json TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS security_audit_log (
    id INTEGER PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    tenant_id TEXT,
    metadata_json TEXT
  )`
] as const;

export async function ensureTenantDbSchema(): Promise<void> {
  for (const statement of TABLE_DDL) {
    await env.TENANT_DB.prepare(statement).run();
  }

  const now = new Date().toISOString();
  await env.TENANT_DB.batch([
    env.TENANT_DB.prepare('DELETE FROM user_sessions'),
    env.TENANT_DB.prepare('DELETE FROM user_api_tokens'),
    env.TENANT_DB.prepare('DELETE FROM invites'),
    env.TENANT_DB.prepare('DELETE FROM users'),
    env.TENANT_DB.prepare('DELETE FROM security_audit_log'),
    env.TENANT_DB.prepare('DELETE FROM app_tenant_config'),
    env.TENANT_DB.prepare(
      `INSERT INTO app_tenant_config
       (id, external_id, slug, name, status, domain, created_by_user_id, seat_limit, created_at, updated_at)
       VALUES (1, ?, 'local', 'Local deployment', 'active', NULL, 'system', 100, ?, ?)`
    ).bind(TENANT_ID, now, now)
  ]);
}
