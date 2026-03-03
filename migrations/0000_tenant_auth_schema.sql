CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
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
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  seat_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  active_tenant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_invites (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
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
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_support_sessions (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  admin_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
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

CREATE INDEX IF NOT EXISTS idx_memberships_user ON tenant_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON tenant_memberships(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_token ON tenant_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_token ON platform_support_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_audit_at ON security_audit_log(at);
