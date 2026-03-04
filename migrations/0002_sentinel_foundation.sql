CREATE TABLE IF NOT EXISTS repo_sentinel_configs (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, repo_id)
);

CREATE TABLE IF NOT EXISTS sentinel_runs (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('group', 'global')),
  scope_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped', 'failed', 'completed')),
  current_task_id TEXT,
  current_run_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sentinel_events (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  sentinel_run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_repo_sentinel_configs_tenant_repo
  ON repo_sentinel_configs (tenant_id, repo_id);

CREATE INDEX IF NOT EXISTS idx_sentinel_runs_tenant_repo_status
  ON sentinel_runs (tenant_id, repo_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentinel_runs_scope
  ON sentinel_runs (tenant_id, scope_type, scope_value, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sentinel_events_tenant_repo_at
  ON sentinel_events (tenant_id, repo_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_sentinel_events_run_at
  ON sentinel_events (sentinel_run_id, at DESC);
