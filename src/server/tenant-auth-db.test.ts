import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptTenantInvite,
  createTenantInvite,
  createUserApiToken,
  listTenantInvites,
  listUserApiTokens,
  login,
  resolveApiToken,
  resolvePendingTenantInviteByToken,
  resolveSessionByToken,
  revokeUserApiToken,
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
          { name: 'security_audit_log' }
        ]
      };
    }

    if (sql === 'SELECT * FROM app_tenant_config LIMIT 1') {
      return { results: [this.appTenantConfig] };
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
});
