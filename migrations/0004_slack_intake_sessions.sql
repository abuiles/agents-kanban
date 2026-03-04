CREATE TABLE IF NOT EXISTS slack_intake_sessions (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_confidence REAL,
  session_json TEXT NOT NULL DEFAULT '{}',
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_intake_sessions_tenant_channel_thread
  ON slack_intake_sessions (tenant_id, channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_slack_intake_sessions_status
  ON slack_intake_sessions (tenant_id, status, last_activity_at);
