ALTER TABLE sentinel_runs ADD COLUMN controller_lease_token TEXT;
ALTER TABLE sentinel_runs ADD COLUMN controller_lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sentinel_runs_lease
  ON sentinel_runs (tenant_id, repo_id, controller_lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sentinel_runs_single_running_repo
  ON sentinel_runs (tenant_id, repo_id)
  WHERE status = 'running';
