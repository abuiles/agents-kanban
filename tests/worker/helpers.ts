import { env } from 'cloudflare:test';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS app_tenant_config (
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
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
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
);

CREATE TABLE IF NOT EXISTS user_api_tokens (
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
);

CREATE TABLE IF NOT EXISTS security_audit_log (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  tenant_id TEXT,
  metadata_json TEXT
);
`;

const RESET_SQL = [
  'DELETE FROM user_sessions',
  'DELETE FROM user_api_tokens',
  'DELETE FROM invites',
  'DELETE FROM users',
  'DELETE FROM security_audit_log',
  'DELETE FROM app_tenant_config'
];

export async function ensureTenantDbSchema() {
  const db = env.TENANT_DB;
  const now = new Date().toISOString();

  for (const statement of MIGRATION_SQL.split(';')) {
    const sql = statement.trim();
    if (!sql) {
      continue;
    }
    await db.prepare(`${sql};`).run();
  }

  for (const statement of RESET_SQL) {
    await db.prepare(statement).run();
  }

  await db.prepare(
    `INSERT INTO app_tenant_config
      (id, external_id, slug, name, status, domain, created_by_user_id, seat_limit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    1,
    'tenant_local',
    'local',
    'Local deployment',
    'active',
    null,
    'system',
    100,
    now,
    now
  ).run();
}
