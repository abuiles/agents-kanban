import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireSentinelRunLease,
  appendSentinelEvent,
  acceptTenantInvite,
  createSentinelRun,
  deleteIntegrationConfig,
  deleteJiraProjectRepoMapping,
  deleteSlackThreadBinding,
  createTenantInvite,
  getRepoSentinelConfig,
  getSentinelRun,
  getIntegrationConfig,
  getSlackThreadBinding,
  createUserApiToken,
  listIntegrationConfigs,
  listJiraProjectRepoMappings,
  listJiraProjectRepoMappingsByProject,
  listSlackThreadBindings,
  listSentinelEvents,
  listSentinelRuns,
  upsertIntegrationConfig,
  upsertJiraProjectRepoMapping,
  upsertRepoSentinelConfig,
  upsertSlackThreadBinding,
  updateSentinelRun,
  listTenantInvites,
  listUserApiTokens,
  login,
  resolveApiToken,
  resolvePendingTenantInviteByToken,
  resolveSessionByToken,
  revokeUserApiToken,
  releaseSentinelRunLease,
  signup
} from './tenant-auth-db';

type Row = Record<string, unknown>;

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly execute: (sql: string, bindings: unknown[]) => Promise<{ results?: Row[] }>
  ) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async run() {
    return this.execute(this.sql, this.bindings);
  }

  async all<T>() {
    return this.execute(this.sql, this.bindings) as Promise<{ results: T[] }>;
  }

  async first<T>() {
    const result = await this.execute(this.sql, this.bindings);
    return (result.results?.[0] as T | undefined) ?? null;
  }
}

class FakeTenantAuthDb {
  appTenantConfig: Row = {
    id: 1,
    external_id: 'tenant_local',
    slug: 'local',
    name: 'Local Tenant',
    status: 'active',
    domain: null,
    created_by_user_id: 'system',
    seat_limit: 100,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  };

  users: Row[] = [];
  userSessions: Row[] = [];
  invites: Row[] = [];
  userApiTokens: Row[] = [];
  securityAuditLog: Row[] = [];
  integrationConfigs: Row[] = [];
  jiraProjectRepoMappings: Row[] = [];
  slackThreadBindings: Row[] = [];
  repoSentinelConfigs: Row[] = [];
  sentinelRuns: Row[] = [];
  sentinelEvents: Row[] = [];

  prepare(sql: string) {
    return new FakeD1Statement(sql, (statement, bindings) => this.execute(statement, bindings));
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const statement of statements) {
      await statement.run();
    }
    return [];
  }

  private async execute(sql: string, bindings: unknown[]): Promise<{ results?: Row[] }> {
    if (sql.includes('FROM sqlite_master')) {
      return {
        results: [
          { name: 'app_tenant_config' },
          { name: 'users' },
          { name: 'user_sessions' },
          { name: 'invites' },
          { name: 'user_api_tokens' },
          { name: 'security_audit_log' },
          { name: 'integration_configs' },
          { name: 'jira_project_repo_mappings' },
          { name: 'slack_thread_bindings' },
          { name: 'repo_sentinel_configs' },
          { name: 'sentinel_runs' },
          { name: 'sentinel_events' }
        ]
      };
    }

    if (sql === 'SELECT * FROM app_tenant_config LIMIT 1') {
      return { results: [this.appTenantConfig] };
    }

    if (sql.includes('INSERT INTO integration_configs')) {
      const row = {
        external_id: String(bindings[0]),
        tenant_id: String(bindings[1]),
        scope_type: String(bindings[2]),
        scope_id: String(bindings[3] ?? ''),
        plugin_kind: String(bindings[4]),
        enabled: bindings[5],
        settings_json: String(bindings[6]),
        secret_ref: bindings[7],
        created_at: bindings[8],
        updated_at: bindings[9]
      };
      const existingIndex = this.integrationConfigs.findIndex((entry) => (
        entry.tenant_id === row.tenant_id
        && entry.scope_type === row.scope_type
        && entry.scope_id === row.scope_id
        && entry.plugin_kind === row.plugin_kind
      ));
      if (existingIndex >= 0) {
        this.integrationConfigs[existingIndex] = {
          ...this.integrationConfigs[existingIndex],
          enabled: row.enabled,
          settings_json: row.settings_json,
          secret_ref: row.secret_ref,
          updated_at: row.updated_at
        };
      } else {
        const createdAt = this.integrationConfigs[existingIndex]?.created_at ?? row.created_at;
        this.integrationConfigs.push({
          ...row,
          created_at: createdAt
        });
      }
      return {};
    }

    if (sql.includes('SELECT * FROM integration_configs')) {
      const tenantId = String(bindings[0]);
      const pluginKindIndex = sql.includes('plugin_kind = ?') ? 1 : -1;
      const scopeTypeIndex = sql.includes('scope_type = ?') ? (pluginKindIndex >= 0 ? 2 : 1) : -1;
      const scopeIdIndex = sql.includes('scope_id = ?') ? ((scopeTypeIndex >= 0 ? scopeTypeIndex + 1 : 1) + (pluginKindIndex >= 0 ? 0 : 0)) : -1;
      const requestedPluginKind = pluginKindIndex >= 0 ? String(bindings[pluginKindIndex]) : undefined;
      const requestedScopeType = scopeTypeIndex >= 0 ? String(bindings[scopeTypeIndex]) : undefined;
      const requestedScopeId = scopeIdIndex >= 0 ? String(bindings[scopeIdIndex]) : undefined;
      let rows = this.integrationConfigs.filter((row) => row.tenant_id === tenantId);
      if (requestedPluginKind) {
        rows = rows.filter((row) => row.plugin_kind === requestedPluginKind);
      }
      if (requestedScopeType) {
        rows = rows.filter((row) => row.scope_type === requestedScopeType);
      }
      if (requestedScopeId && requestedScopeType !== 'tenant') {
        rows = rows.filter((row) => row.scope_id === requestedScopeId);
      }
      if (sql.includes('enabled = 1')) {
        rows = rows.filter((row) => Number(row.enabled) === 1);
      }
      if (sql.includes('ORDER BY updated_at DESC')) {
        rows = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      }
      if (sql.includes('LIMIT 1')) {
        rows = rows.slice(0, 1);
      }
      return { results: rows };
    }

    if (sql.includes('INSERT INTO jira_project_repo_mappings')) {
      const row = {
        external_id: String(bindings[0]),
        tenant_id: String(bindings[1]),
        jira_project_key: String(bindings[2]),
        repo_id: String(bindings[3]),
        priority: bindings[4],
        active: bindings[5],
        created_at: bindings[6],
        updated_at: bindings[7]
      };
      const existingIndex = this.jiraProjectRepoMappings.findIndex((entry) => (
        entry.tenant_id === row.tenant_id
        && entry.jira_project_key === row.jira_project_key
        && entry.repo_id === row.repo_id
      ));
      if (existingIndex >= 0) {
        this.jiraProjectRepoMappings[existingIndex] = {
          ...this.jiraProjectRepoMappings[existingIndex],
          priority: row.priority,
          active: row.active,
          updated_at: row.updated_at
        };
      } else {
        const createdAt = this.jiraProjectRepoMappings[existingIndex]?.created_at ?? row.created_at;
        this.jiraProjectRepoMappings.push({ ...row, created_at: createdAt });
      }
      return {};
    }

    if (sql.includes('SELECT * FROM jira_project_repo_mappings')) {
      const tenantId = String(bindings[0]);
      let index = 1;
      const rowsByProject = this.jiraProjectRepoMappings.filter((row) => row.tenant_id === tenantId);
      let projectFiltered = rowsByProject;
      if (sql.includes('jira_project_key = ?')) {
        const jiraProjectKey = String(bindings[index++]);
        projectFiltered = projectFiltered.filter((row) => String(row.jira_project_key).toUpperCase() === jiraProjectKey);
      }
      if (sql.includes('repo_id = ?')) {
        const repoId = String(bindings[index++]);
        projectFiltered = projectFiltered.filter((row) => row.repo_id === repoId);
      }
      if (sql.includes('active = 1')) {
        projectFiltered = projectFiltered.filter((row) => Number(row.active) === 1);
      }
      const rows = [...projectFiltered].sort((left, right) => {
        if (Number(left.priority) === Number(right.priority)) {
          return String(right.updated_at).localeCompare(String(left.updated_at));
        }
        return Number(left.priority) - Number(right.priority);
      });
      return { results: rows };
    }

    if (sql.includes('INSERT INTO slack_thread_bindings')) {
      const row = {
        external_id: String(bindings[0]),
        tenant_id: String(bindings[1]),
        task_id: String(bindings[2]),
        channel_id: String(bindings[3]),
        thread_ts: String(bindings[4]),
        current_run_id: bindings[5] ? String(bindings[5]) : null,
        latest_review_round: bindings[6],
        created_at: bindings[7],
        updated_at: bindings[8]
      };
      const existingIndex = this.slackThreadBindings.findIndex((entry) => (
        entry.tenant_id === row.tenant_id
        && entry.task_id === row.task_id
        && entry.channel_id === row.channel_id
      ));
      if (existingIndex >= 0) {
        this.slackThreadBindings[existingIndex] = {
          ...this.slackThreadBindings[existingIndex],
          thread_ts: row.thread_ts,
          current_run_id: row.current_run_id,
          latest_review_round: row.latest_review_round,
          updated_at: row.updated_at
        };
      } else {
        const createdAt = this.slackThreadBindings[existingIndex]?.created_at ?? row.created_at;
        this.slackThreadBindings.push({ ...row, created_at: createdAt });
      }
      return {};
    }

    if (sql.includes('SELECT * FROM slack_thread_bindings')) {
      const tenantId = String(bindings[0]);
      let rows = this.slackThreadBindings.filter((row) => row.tenant_id === tenantId);
      let index = 1;
      if (sql.includes('task_id = ?')) {
        const taskId = String(bindings[index++]);
        rows = rows.filter((row) => row.task_id === taskId);
      }
      if (sql.includes('current_run_id = ?')) {
        const currentRunId = String(bindings[index++]);
        rows = rows.filter((row) => String(row.current_run_id ?? '') === currentRunId);
      }
      if (sql.includes('channel_id = ?')) {
        const channelId = String(bindings[index++]);
        rows = rows.filter((row) => row.channel_id === channelId);
      }
      if (sql.includes('LIMIT 1')) {
        rows = rows.slice(0, 1);
      }
      return { results: rows };
    }

    if (sql.includes('INSERT INTO repo_sentinel_configs')) {
      const row = {
        external_id: String(bindings[0]),
        tenant_id: String(bindings[1]),
        repo_id: String(bindings[2]),
        config_json: String(bindings[3]),
        created_at: String(bindings[4]),
        updated_at: String(bindings[5])
      };
      const existingIndex = this.repoSentinelConfigs.findIndex((entry) => (
        entry.tenant_id === row.tenant_id
        && entry.repo_id === row.repo_id
      ));
      if (existingIndex >= 0) {
        this.repoSentinelConfigs[existingIndex] = {
          ...this.repoSentinelConfigs[existingIndex],
          config_json: row.config_json,
          updated_at: row.updated_at
        };
      } else {
        this.repoSentinelConfigs.push(row);
      }
      return {};
    }

    if (sql.includes('SELECT * FROM repo_sentinel_configs')) {
      const tenantId = String(bindings[0]);
      const repoId = String(bindings[1]);
      return {
        results: this.repoSentinelConfigs.filter((row) => row.tenant_id === tenantId && row.repo_id === repoId).slice(0, 1)
      };
    }

    if (sql.includes('INSERT INTO sentinel_runs')) {
      const tenantId = String(bindings[1]);
      const repoId = String(bindings[2]);
      const status = String(bindings[5]);
      if (status === 'running') {
        const duplicateRunning = this.sentinelRuns.some((row) => (
          row.tenant_id === tenantId
          && row.repo_id === repoId
          && row.status === 'running'
        ));
        if (duplicateRunning) {
          throw new Error('UNIQUE constraint failed: sentinel_runs.tenant_id, sentinel_runs.repo_id');
        }
      }
      this.sentinelRuns.push({
        external_id: String(bindings[0]),
        tenant_id: tenantId,
        repo_id: repoId,
        scope_type: String(bindings[3]),
        scope_value: bindings[4] ? String(bindings[4]) : null,
        status,
        current_task_id: bindings[6] ? String(bindings[6]) : null,
        current_run_id: bindings[7] ? String(bindings[7]) : null,
        attempt_count: Number(bindings[8]),
        started_at: String(bindings[9]),
        updated_at: String(bindings[10]),
        controller_lease_token: null,
        controller_lease_expires_at: null
      });
      return {};
    }

    if (sql.includes('UPDATE sentinel_runs') && sql.includes('current_task_id IS NULL')) {
      const taskId = bindings[0] ? String(bindings[0]) : null;
      const taskRunId = bindings[1] ? String(bindings[1]) : null;
      const updatedAt = String(bindings[2]);
      const tenantId = String(bindings[3]);
      const runId = String(bindings[4]);
      this.sentinelRuns = this.sentinelRuns.map((row) => (
        row.tenant_id === tenantId && row.external_id === runId && row.status === 'running' && !row.current_task_id
          ? {
              ...row,
              current_task_id: taskId,
              current_run_id: taskRunId,
              updated_at: updatedAt
            }
          : row
      ));
      return {};
    }

    if (sql.includes('SELECT external_id FROM sentinel_runs')) {
      const tenantId = String(bindings[0]);
      const runId = String(bindings[1]);
      const status = String(bindings[2]);
      const taskId = String(bindings[3]);
      return {
        results: this.sentinelRuns
          .filter((row) => row.tenant_id === tenantId && row.external_id === runId && row.status === status && row.current_task_id === taskId)
          .map((row) => ({ external_id: row.external_id }))
      };
    }

    if (sql.includes('UPDATE sentinel_runs') && sql.includes('controller_lease_token = ?, controller_lease_expires_at = ?, updated_at = ?')) {
      const leaseToken = String(bindings[0]);
      const leaseExpiresAt = String(bindings[1]);
      const updatedAt = String(bindings[2]);
      const tenantId = String(bindings[3]);
      const runId = String(bindings[4]);
      const sameLeaseToken = String(bindings[5]);
      const now = String(bindings[6]);
      this.sentinelRuns = this.sentinelRuns.map((row) => {
        const canAcquire = (
          row.tenant_id === tenantId
          && row.external_id === runId
          && row.status === 'running'
          && (
            !row.controller_lease_token
            || row.controller_lease_token === sameLeaseToken
            || !row.controller_lease_expires_at
            || String(row.controller_lease_expires_at) <= now
          )
        );
        if (!canAcquire) {
          return row;
        }
        return {
          ...row,
          controller_lease_token: leaseToken,
          controller_lease_expires_at: leaseExpiresAt,
          updated_at: updatedAt
        };
      });
      return {};
    }

    if (sql.includes('UPDATE sentinel_runs') && sql.includes('controller_lease_token = NULL, controller_lease_expires_at = NULL')) {
      const updatedAt = String(bindings[0]);
      const tenantId = String(bindings[1]);
      const runId = String(bindings[2]);
      const leaseToken = String(bindings[3]);
      this.sentinelRuns = this.sentinelRuns.map((row) => (
        row.tenant_id === tenantId && row.external_id === runId && row.controller_lease_token === leaseToken
          ? {
              ...row,
              controller_lease_token: null,
              controller_lease_expires_at: null,
              updated_at: updatedAt
            }
          : row
      ));
      return {};
    }

    if (sql.includes('UPDATE sentinel_runs') && sql.includes('SET status = ?, current_task_id = ?, current_run_id = ?, attempt_count = ?, updated_at = ?,')) {
      const status = String(bindings[0]);
      const currentTaskId = bindings[1] ? String(bindings[1]) : null;
      const currentRunId = bindings[2] ? String(bindings[2]) : null;
      const attemptCount = Number(bindings[3]);
      const updatedAt = String(bindings[4]);
      const shouldClearLease = Number(bindings[5]) === 1;
      const tenantId = String(bindings[7]);
      const runId = String(bindings[8]);
      this.sentinelRuns = this.sentinelRuns.map((row) => (
        row.tenant_id === tenantId && row.external_id === runId
          ? {
              ...row,
              status,
              current_task_id: currentTaskId,
              current_run_id: currentRunId,
              attempt_count: attemptCount,
              updated_at: updatedAt,
              ...(shouldClearLease ? { controller_lease_token: null, controller_lease_expires_at: null } : {})
            }
          : row
      ));
      return {};
    }

    if (sql.includes('SELECT * FROM sentinel_runs')) {
      const tenantId = String(bindings[0]);
      let index = 1;
      let rows = this.sentinelRuns.filter((row) => row.tenant_id === tenantId);
      if (sql.includes('external_id = ?')) {
        const runId = String(bindings[index]);
        rows = rows.filter((row) => row.external_id === runId);
        index += 1;
      }
      if (sql.includes('controller_lease_token = ?')) {
        const leaseToken = String(bindings[index++]);
        rows = rows.filter((row) => row.controller_lease_token === leaseToken);
      }
      if (sql.includes('controller_lease_expires_at > ?')) {
        const now = String(bindings[index++]);
        rows = rows.filter((row) => row.controller_lease_expires_at && String(row.controller_lease_expires_at) > now);
      }
      if (sql.includes('repo_id = ?')) {
        const repoId = String(bindings[index++]);
        rows = rows.filter((row) => row.repo_id === repoId);
      }
      if (sql.includes('status = ?')) {
        const status = String(bindings[index++]);
        rows = rows.filter((row) => row.status === status);
      }
      if (sql.includes('LIMIT 1')) {
        rows = rows.slice(0, 1);
      }
      if (sql.includes('ORDER BY started_at DESC')) {
        rows = [...rows].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      }
      return { results: rows };
    }

    if (sql.includes('INSERT INTO sentinel_events')) {
      this.sentinelEvents.push({
        external_id: String(bindings[0]),
        sentinel_run_id: String(bindings[1]),
        tenant_id: String(bindings[2]),
        repo_id: String(bindings[3]),
        at: String(bindings[4]),
        level: String(bindings[5]),
        type: String(bindings[6]),
        message: String(bindings[7]),
        metadata_json: bindings[8] ? String(bindings[8]) : null
      });
      return {};
    }

    if (sql.includes('SELECT * FROM sentinel_events')) {
      const tenantId = String(bindings[0]);
      let rows = this.sentinelEvents.filter((row) => row.tenant_id === tenantId);
      let index = 1;
      if (sql.includes('external_id = ?')) {
        const eventId = String(bindings[index++]);
        rows = rows.filter((row) => row.external_id === eventId);
      }
      if (sql.includes('repo_id = ?')) {
        const repoId = String(bindings[index++]);
        rows = rows.filter((row) => row.repo_id === repoId);
      }
      if (sql.includes('sentinel_run_id = ?')) {
        const runId = String(bindings[index++]);
        rows = rows.filter((row) => row.sentinel_run_id === runId);
      }
      if (sql.includes('ORDER BY at DESC')) {
        rows = [...rows].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      }
      if (sql.includes('LIMIT ')) {
        const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) {
          rows = rows.slice(0, Number(limitMatch[1]));
        }
      }
      return { results: rows };
    }

    if (sql === 'SELECT external_id FROM users WHERE email = ? LIMIT 1') {
      const email = String(bindings[0]);
      return { results: this.users.filter((row) => row.email === email).slice(0, 1) };
    }

    if (sql === 'SELECT COUNT(*) AS count FROM users') {
      return { results: [{ count: this.users.length }] };
    }

    if (sql === 'INSERT INTO users (external_id, email, display_name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)') {
      this.users.push({
        external_id: bindings[0],
        email: bindings[1],
        display_name: bindings[2],
        role: bindings[3],
        password_hash: bindings[4],
        created_at: bindings[5],
        updated_at: bindings[6]
      });
      return {};
    }

    if (sql === 'SELECT * FROM users WHERE email = ? LIMIT 1') {
      const email = String(bindings[0]);
      return { results: this.users.filter((row) => row.email === email).slice(0, 1) };
    }

    if (sql === 'UPDATE users SET password_hash = ?, updated_at = ? WHERE external_id = ?') {
      const passwordHash = String(bindings[0]);
      const updatedAt = String(bindings[1]);
      const userId = String(bindings[2]);
      this.users = this.users.map((row) => (
        row.external_id === userId
          ? { ...row, password_hash: passwordHash, updated_at: updatedAt }
          : row
      ));
      return {};
    }

    if (sql === 'INSERT INTO user_sessions (external_id, user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)') {
      this.userSessions.push({
        external_id: bindings[0],
        user_id: bindings[1],
        token_hash: bindings[2],
        expires_at: bindings[3],
        last_seen_at: bindings[4]
      });
      return {};
    }

    if (sql === 'SELECT * FROM user_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1') {
      const tokenHash = String(bindings[0]);
      const now = String(bindings[1]);
      return {
        results: this.userSessions
          .filter((row) => row.token_hash === tokenHash && String(row.expires_at) > now)
          .slice(0, 1)
      };
    }

    if (sql === 'SELECT * FROM users WHERE external_id = ? LIMIT 1') {
      const userId = String(bindings[0]);
      return { results: this.users.filter((row) => row.external_id === userId).slice(0, 1) };
    }

    if (sql === 'UPDATE user_sessions SET last_seen_at = ? WHERE external_id = ?') {
      const lastSeenAt = String(bindings[0]);
      const sessionId = String(bindings[1]);
      this.userSessions = this.userSessions.map((row) => (
        row.external_id === sessionId ? { ...row, last_seen_at: lastSeenAt } : row
      ));
      return {};
    }

    if (sql === 'DELETE FROM user_sessions WHERE external_id = ?') {
      const sessionId = String(bindings[0]);
      this.userSessions = this.userSessions.filter((row) => row.external_id !== sessionId);
      return {};
    }

    if (sql === 'SELECT role FROM users WHERE external_id = ? LIMIT 1') {
      const userId = String(bindings[0]);
      return { results: this.users.filter((row) => row.external_id === userId).map((row) => ({ role: row.role })).slice(0, 1) };
    }

    if (sql === "SELECT external_id FROM invites WHERE email = ? AND status = 'pending' AND expires_at > ? LIMIT 1") {
      const email = String(bindings[0]);
      const now = String(bindings[1]);
      return {
        results: this.invites
          .filter((row) => row.email === email && row.status === 'pending' && String(row.expires_at) > now)
          .map((row) => ({ external_id: row.external_id }))
          .slice(0, 1)
      };
    }

    if (sql.includes('INSERT INTO invites')) {
      this.invites.push({
        external_id: bindings[0],
        email: bindings[1],
        role: bindings[2],
        status: bindings[3],
        token_hash: bindings[4],
        created_by_user_id: bindings[5],
        accepted_by_user_id: null,
        accepted_at: null,
        revoked_at: null,
        expires_at: bindings[6],
        created_at: bindings[7],
        updated_at: bindings[8]
      });
      return {};
    }

    if (sql === 'SELECT * FROM invites ORDER BY created_at DESC') {
      return {
        results: [...this.invites].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      };
    }

    if (sql === "SELECT * FROM invites WHERE token_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1") {
      const tokenHash = String(bindings[0]);
      const now = String(bindings[1]);
      return {
        results: this.invites
          .filter((row) => row.token_hash === tokenHash && row.status === 'pending' && String(row.expires_at) > now)
          .slice(0, 1)
      };
    }

    if (sql === 'UPDATE users SET role = ?, updated_at = ? WHERE external_id = ?') {
      const role = String(bindings[0]);
      const updatedAt = String(bindings[1]);
      const userId = String(bindings[2]);
      this.users = this.users.map((row) => (row.external_id === userId ? { ...row, role, updated_at: updatedAt } : row));
      return {};
    }

    if (sql === "UPDATE invites SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ? WHERE external_id = ?") {
      const acceptedByUserId = String(bindings[0]);
      const acceptedAt = String(bindings[1]);
      const updatedAt = String(bindings[2]);
      const inviteId = String(bindings[3]);
      this.invites = this.invites.map((row) => (
        row.external_id === inviteId
          ? { ...row, status: 'accepted', accepted_by_user_id: acceptedByUserId, accepted_at: acceptedAt, updated_at: updatedAt }
          : row
      ));
      return {};
    }

    if (sql === 'INSERT INTO security_audit_log (external_id, at, actor_type, actor_id, action, tenant_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)') {
      this.securityAuditLog.push({
        external_id: bindings[0],
        at: bindings[1],
        actor_type: bindings[2],
        actor_id: bindings[3],
        action: bindings[4],
        tenant_id: bindings[5],
        metadata_json: bindings[6]
      });
      return {};
    }

    if (sql === 'SELECT external_id FROM users WHERE external_id = ? LIMIT 1') {
      const userId = String(bindings[0]);
      return {
        results: this.users
          .filter((row) => row.external_id === userId)
          .map((row) => ({ external_id: row.external_id }))
          .slice(0, 1)
      };
    }

    if (sql.includes('INSERT INTO user_api_tokens')) {
      this.userApiTokens.push({
        external_id: bindings[0],
        user_id: bindings[1],
        name: bindings[2],
        scopes_json: bindings[3],
        token_hash: bindings[4],
        expires_at: bindings[5],
        last_used_at: null,
        revoked_at: null,
        created_at: bindings[6],
        updated_at: bindings[7]
      });
      return {};
    }

    if (sql === 'SELECT * FROM user_api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC') {
      const userId = String(bindings[0]);
      return {
        results: this.userApiTokens
          .filter((row) => row.user_id === userId && row.revoked_at === null)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      };
    }

    if (sql === 'SELECT * FROM user_api_tokens WHERE external_id = ? LIMIT 1') {
      const tokenId = String(bindings[0]);
      return { results: this.userApiTokens.filter((row) => row.external_id === tokenId).slice(0, 1) };
    }

    if (sql === 'UPDATE user_api_tokens SET revoked_at = ?, updated_at = ? WHERE external_id = ?') {
      const revokedAt = String(bindings[0]);
      const updatedAt = String(bindings[1]);
      const tokenId = String(bindings[2]);
      this.userApiTokens = this.userApiTokens.map((row) => (
        row.external_id === tokenId ? { ...row, revoked_at: revokedAt, updated_at: updatedAt } : row
      ));
      return {};
    }

    if (sql === 'SELECT * FROM user_api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1') {
      const tokenHash = String(bindings[0]);
      const now = String(bindings[1]);
      return {
        results: this.userApiTokens
          .filter((row) => row.token_hash === tokenHash && row.revoked_at === null && (!row.expires_at || String(row.expires_at) > now))
          .slice(0, 1)
      };
    }

    if (sql === 'UPDATE user_api_tokens SET last_used_at = ?, updated_at = ? WHERE external_id = ?') {
      const lastUsedAt = String(bindings[0]);
      const updatedAt = String(bindings[1]);
      const tokenId = String(bindings[2]);
      this.userApiTokens = this.userApiTokens.map((row) => (
        row.external_id === tokenId ? { ...row, last_used_at: lastUsedAt, updated_at: updatedAt } : row
      ));
      return {};
    }

    if (sql === 'DELETE FROM integration_configs WHERE tenant_id = ? AND external_id = ?') {
      const tenantId = String(bindings[0]);
      const configId = String(bindings[1]);
      this.integrationConfigs = this.integrationConfigs.filter(
        (row) => !(row.tenant_id === tenantId && String(row.external_id) === configId)
      );
      return {};
    }

    if (sql === 'DELETE FROM jira_project_repo_mappings WHERE tenant_id = ? AND external_id = ?') {
      const tenantId = String(bindings[0]);
      const mappingId = String(bindings[1]);
      this.jiraProjectRepoMappings = this.jiraProjectRepoMappings.filter(
        (row) => !(row.tenant_id === tenantId && String(row.external_id) === mappingId)
      );
      return {};
    }

    if (sql === 'DELETE FROM slack_thread_bindings WHERE tenant_id = ? AND task_id = ? AND channel_id = ?') {
      const tenantId = String(bindings[0]);
      const taskId = String(bindings[1]);
      const channelId = String(bindings[2]);
      this.slackThreadBindings = this.slackThreadBindings.filter(
        (row) => !(row.tenant_id === tenantId && row.task_id === taskId && row.channel_id === channelId)
      );
      return {};
    }

    if (sql === 'SELECT * FROM users ORDER BY created_at ASC') {
      return { results: [...this.users] };
    }

    if (sql === 'SELECT COUNT(*) AS seats_used FROM users') {
      return { results: [{ seats_used: this.users.length }] };
    }

    throw new Error(`Unhandled SQL in fake tenant auth DB: ${sql}`);
  }
}

describe('tenant-auth-db single-tenant auth store', () => {
  let db: FakeTenantAuthDb;
  let env: Env;

  beforeEach(() => {
    db = new FakeTenantAuthDb();
    env = { TENANT_DB: db } as unknown as Env;
  });

  it('creates first user as owner and resolves session with singleton tenant', async () => {
    const created = await signup(env, {
      email: 'owner@example.com',
      password: 'secret-pass',
      displayName: 'Owner',
      tenant: { name: 'ignored' }
    });

    expect(created.user.email).toBe('owner@example.com');
    expect(created.activeTenantId).toBe('tenant_local');
    expect(created.memberships).toHaveLength(1);
    expect(created.memberships[0].role).toBe('owner');

    const resolved = await resolveSessionByToken(env, created.token);
    expect(resolved.user.id).toBe(created.user.id);
    expect(resolved.session.activeTenantId).toBe('tenant_local');
  });

  it('persists invites and accepts invite for matching user email', async () => {
    const owner = await signup(env, {
      email: 'owner@example.com',
      password: 'secret-pass',
      tenant: { name: 'ignored' }
    });
    const member = await signup(env, {
      email: 'member@example.com',
      password: 'secret-pass',
      tenant: { name: 'ignored' }
    });

    const createdInvite = await createTenantInvite(env, 'tenant_local', { email: 'member@example.com', role: 'owner' }, owner.user.id);
    expect(createdInvite.invite.email).toBe('member@example.com');
    expect(createdInvite.invite.status).toBe('pending');

    const listed = await listTenantInvites(env, 'tenant_local', owner.user.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(createdInvite.invite.id);

    const resolved = await resolvePendingTenantInviteByToken(env, createdInvite.token);
    expect(resolved.invite.id).toBe(createdInvite.invite.id);

    const accepted = await acceptTenantInvite(env, createdInvite.token, member.user.id);
    expect(accepted.invite.status).toBe('accepted');
    expect(accepted.membership.role).toBe('owner');
  });

  it('supports personal API token create/list/resolve/revoke lifecycle', async () => {
    const created = await signup(env, {
      email: 'owner@example.com',
      password: 'secret-pass',
      tenant: { name: 'ignored' }
    });

    const pat = await createUserApiToken(env, created.user.id, {
      name: 'CI Token',
      scopes: ['board:read', 'runs:write']
    });
    expect(pat.token).toBeTruthy();
    expect(pat.tokenRecord.name).toBe('CI Token');

    const listed = await listUserApiTokens(env, created.user.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].scopes).toEqual(['board:read', 'runs:write']);

    const resolved = await resolveApiToken(env, pat.token);
    expect(resolved.user.id).toBe(created.user.id);
    expect(resolved.tokenRecord.id).toBe(pat.tokenRecord.id);
    expect(resolved.tokenRecord.lastUsedAt).toBeTruthy();

    await revokeUserApiToken(env, created.user.id, pat.tokenRecord.id);
    const afterRevoke = await listUserApiTokens(env, created.user.id);
    expect(afterRevoke).toHaveLength(0);

    await expect(resolveApiToken(env, pat.token)).rejects.toMatchObject({ body: { code: 'UNAUTHORIZED' } });
  });

  it('rejects login for unknown singleton tenant id override', async () => {
    await signup(env, {
      email: 'owner@example.com',
      password: 'secret-pass',
      tenant: { name: 'ignored' }
    });

    await expect(login(env, {
      email: 'owner@example.com',
      password: 'secret-pass',
      tenantId: 'tenant_other'
    })).rejects.toMatchObject({ body: { code: 'FORBIDDEN' } });
  });

  it('upgrades legacy SHA-256 password hashes on successful login', async () => {
    const created = await signup(env, {
      email: 'owner@example.com',
      password: 'secret-pass',
      tenant: { name: 'ignored' }
    });

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('secret-pass'));
    const legacyHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    db.users = db.users.map((row) => (
      row.external_id === created.user.id
        ? { ...row, password_hash: legacyHash }
        : row
    ));

    const loggedIn = await login(env, {
      email: 'owner@example.com',
      password: 'secret-pass'
    });
    expect(loggedIn.user.id).toBe(created.user.id);

    const upgraded = db.users.find((row) => row.external_id === created.user.id);
    expect(String(upgraded?.password_hash)).toMatch(/^pbkdf2_sha256\$\d+\$[a-f0-9]+\$[a-f0-9]{64}$/);
  });

  it('supports integration config persistence with scope-specific upsert/list/get/delete', async () => {
    const tenantId = 'tenant_local';
    const tenantScope = await upsertIntegrationConfig(env, {
      tenantId,
      scopeType: 'tenant',
      pluginKind: 'slack',
      enabled: true,
      settings: { channelDefault: 'yes' }
    });
    const repoScope = await upsertIntegrationConfig(env, {
      tenantId,
      scopeType: 'repo',
      scopeId: 'repo_alpha',
      pluginKind: 'slack',
      enabled: false,
      settings: { command: 'slash' }
    });
    const channelScope = await upsertIntegrationConfig(env, {
      tenantId,
      scopeType: 'channel',
      scopeId: 'C123',
      pluginKind: 'slack',
      enabled: true,
      settings: { mention: true }
    });
    const byScope = await getIntegrationConfig(env, {
      tenantId,
      pluginKind: 'slack',
      scopeType: 'channel',
      scopeId: 'C123'
    });
    expect(byScope?.id).toBe(channelScope.id);
    const tenantByScope = await getIntegrationConfig(env, {
      tenantId,
      pluginKind: 'slack',
      scopeType: 'tenant'
    });
    expect(tenantByScope?.id).toBe(tenantScope.id);

    const forPlugin = await listIntegrationConfigs(env, tenantId, { pluginKind: 'slack' });
    expect(forPlugin.map((entry) => entry.scopeId).sort()).toEqual([undefined, 'repo_alpha', 'C123'].sort());

    await deleteIntegrationConfig(env, tenantId, repoScope.id);
    const afterDelete = await listIntegrationConfigs(env, tenantId, { pluginKind: 'slack', scopeType: 'repo' });
    expect(afterDelete).toHaveLength(0);

    const overwritten = await upsertIntegrationConfig(env, {
      tenantId,
      scopeType: 'tenant',
      pluginKind: 'slack',
      enabled: true,
      settings: { channelDefault: 'no' }
    });
    expect(overwritten.id).toBe(tenantScope.id);
    expect(overwritten.settings).toEqual({ channelDefault: 'no' });

    expect(tenantScope.id).toBeDefined();
    expect(repoScope.id).toBeDefined();
    expect(channelScope.id).toBeDefined();
    expect(byScope?.scopeType).toBe('channel');
    expect(tenantByScope?.scopeType).toBe('tenant');
  });

  it('persists and orders Jira project mappings', async () => {
    const tenantId = 'tenant_local';
    await upsertJiraProjectRepoMapping(env, {
      tenantId,
      jiraProjectKey: 'ABC',
      repoId: 'repo_z',
      priority: 3
    });
    const midPriority = await upsertJiraProjectRepoMapping(env, {
      tenantId,
      jiraProjectKey: 'ABC',
      repoId: 'repo_m',
      priority: 2
    });
    const highPriority = await upsertJiraProjectRepoMapping(env, {
      tenantId,
      jiraProjectKey: 'ABC',
      repoId: 'repo_a',
      priority: 1
    });
    const listings = await listJiraProjectRepoMappingsByProject(env, tenantId, 'ABC');
    expect(listings.map((row) => row.repoId)).toEqual([highPriority.repoId, midPriority.repoId, 'repo_z']);

    await deleteJiraProjectRepoMapping(env, tenantId, midPriority.id);
    const remaining = await listJiraProjectRepoMappings(env, tenantId, { jiraProjectKey: 'ABC' });
    expect(remaining).toHaveLength(2);
  });

  it('persists slack thread bindings with upsert and lookup by task/channel', async () => {
    const tenantId = 'tenant_local';
    const initial = await upsertSlackThreadBinding(env, {
      tenantId,
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '123.456',
      latestReviewRound: 1
    });
    const updated = await upsertSlackThreadBinding(env, {
      tenantId,
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '789.012',
      currentRunId: 'run_1',
      latestReviewRound: 2
    });
    const lookedUp = await getSlackThreadBinding(env, tenantId, 'task_1', 'C123');
    expect(lookedUp?.id).toBe(initial.id);
    expect(lookedUp?.threadTs).toBe(updated.threadTs);
    expect(lookedUp?.currentRunId).toBe('run_1');
    expect(lookedUp?.latestReviewRound).toBe(2);

    const byTask = await listSlackThreadBindings(env, tenantId, { taskId: 'task_1' });
    expect(byTask).toHaveLength(1);
    expect(byTask[0]?.currentRunId).toBe('run_1');

    const byRun = await listSlackThreadBindings(env, tenantId, { currentRunId: 'run_1' });
    expect(byRun).toHaveLength(1);
    expect(byRun[0]?.taskId).toBe('task_1');

    await deleteSlackThreadBinding(env, tenantId, 'task_1', 'C123');
    const afterDelete = await getSlackThreadBinding(env, tenantId, 'task_1', 'C123');
    expect(afterDelete).toBeUndefined();
  });

  it('persists repo sentinel config and returns deterministic defaults when missing', async () => {
    const tenantId = 'tenant_local';
    const repoId = 'repo_alpha';

    const defaultConfig = await getRepoSentinelConfig(env, tenantId, repoId);
    expect(defaultConfig).toMatchObject({
      enabled: false,
      globalMode: false,
      reviewGate: { requireChecksGreen: true, requireAutoReviewPass: true },
      mergePolicy: { autoMergeEnabled: true, method: 'squash', deleteBranch: true },
      conflictPolicy: { rebaseBeforeMerge: true, remediationEnabled: true, maxAttempts: 2 }
    });

    const updated = await upsertRepoSentinelConfig(env, {
      tenantId,
      repoId,
      config: {
        enabled: true,
        globalMode: true,
        defaultGroupTag: 'p1',
        mergePolicy: { method: 'merge', autoMergeEnabled: false, deleteBranch: false },
        conflictPolicy: { maxAttempts: 5, remediationEnabled: false, rebaseBeforeMerge: false }
      }
    });

    expect(updated.enabled).toBe(true);
    expect(updated.globalMode).toBe(true);
    expect(updated.defaultGroupTag).toBe('p1');
    expect(updated.mergePolicy.method).toBe('merge');
    expect(updated.conflictPolicy.maxAttempts).toBe(5);
  });

  it('persists sentinel runs and events with roundtrip reads', async () => {
    const tenantId = 'tenant_local';
    const repoId = 'repo_alpha';

    const run = await createSentinelRun(env, {
      tenantId,
      repoId,
      scopeType: 'group',
      scopeValue: 'p1',
      status: 'running'
    });
    expect(run.repoId).toBe(repoId);
    expect(run.scopeType).toBe('group');
    expect(run.scopeValue).toBe('p1');

    const updatedRun = await updateSentinelRun(env, tenantId, run.id, {
      status: 'paused',
      currentTaskId: 'task_1',
      currentRunId: 'run_1',
      attemptCount: 2
    });
    expect(updatedRun.status).toBe('paused');
    expect(updatedRun.currentTaskId).toBe('task_1');
    expect(updatedRun.currentRunId).toBe('run_1');
    expect(updatedRun.attemptCount).toBe(2);

    const fetchedRun = await getSentinelRun(env, tenantId, run.id);
    expect(fetchedRun.status).toBe('paused');

    const event = await appendSentinelEvent(env, {
      tenantId,
      repoId,
      sentinelRunId: run.id,
      level: 'info',
      type: 'sentinel.started',
      message: 'Sentinel started',
      metadata: { source: 'test', attempt: 1 }
    });
    expect(event.sentinelRunId).toBe(run.id);
    expect(event.metadata?.source).toBe('test');

    const runEvents = await listSentinelEvents(env, tenantId, { sentinelRunId: run.id });
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].id).toBe(event.id);

    const repoRuns = await listSentinelRuns(env, tenantId, { repoId });
    expect(repoRuns.map((entry) => entry.id)).toContain(run.id);
  });

  it('keeps running sentinel creation idempotent and enforces lease ownership', async () => {
    const tenantId = 'tenant_local';
    const repoId = 'repo_alpha';
    const run = await createSentinelRun(env, {
      tenantId,
      repoId,
      scopeType: 'global',
      status: 'running'
    });

    const duplicate = await createSentinelRun(env, {
      tenantId,
      repoId,
      scopeType: 'group',
      scopeValue: 'payments',
      status: 'running'
    });
    expect(duplicate.id).toBe(run.id);

    const lease1 = await acquireSentinelRunLease(env, tenantId, run.id, {
      leaseToken: 'lease_a',
      ttlSeconds: 30,
      now: '2026-01-01T00:00:00.000Z'
    });
    expect(lease1?.id).toBe(run.id);

    const lease2 = await acquireSentinelRunLease(env, tenantId, run.id, {
      leaseToken: 'lease_b',
      ttlSeconds: 30,
      now: '2026-01-01T00:00:10.000Z'
    });
    expect(lease2).toBeNull();

    await releaseSentinelRunLease(env, tenantId, run.id, 'lease_a', '2026-01-01T00:00:11.000Z');
    const lease3 = await acquireSentinelRunLease(env, tenantId, run.id, {
      leaseToken: 'lease_b',
      ttlSeconds: 30,
      now: '2026-01-01T00:00:12.000Z'
    });
    expect(lease3?.id).toBe(run.id);
  });
});
