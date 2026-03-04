CREATE TABLE IF NOT EXISTS integration_configs (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'repo', 'channel')),
  scope_id TEXT NOT NULL DEFAULT '',
  plugin_kind TEXT NOT NULL CHECK (plugin_kind IN ('slack', 'jira', 'gitlab')),
  enabled INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, plugin_kind, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS jira_project_repo_mappings (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  jira_project_key TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, jira_project_key, repo_id)
);

CREATE TABLE IF NOT EXISTS slack_thread_bindings (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  current_run_id TEXT,
  latest_review_round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, task_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_configs_tenant_plugin_scope
  ON integration_configs (tenant_id, plugin_kind, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_integration_configs_scope_lookup
  ON integration_configs (tenant_id, plugin_kind, scope_type);
CREATE INDEX IF NOT EXISTS idx_integration_configs_enabled
  ON integration_configs (tenant_id, plugin_kind, enabled);

CREATE INDEX IF NOT EXISTS idx_jira_project_repo_mappings_tenant_project
  ON jira_project_repo_mappings (tenant_id, jira_project_key);
CREATE INDEX IF NOT EXISTS idx_jira_project_repo_mappings_priority
  ON jira_project_repo_mappings (tenant_id, jira_project_key, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_jira_project_repo_mappings_active
  ON jira_project_repo_mappings (tenant_id, active);

CREATE INDEX IF NOT EXISTS idx_slack_thread_bindings_tenant_task_channel
  ON slack_thread_bindings (tenant_id, task_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_thread_bindings_tenant_channel
  ON slack_thread_bindings (tenant_id, channel_id);
