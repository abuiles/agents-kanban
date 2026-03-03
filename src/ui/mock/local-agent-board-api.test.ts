import { beforeEach, describe, expect, it } from 'vitest';
import { getLocalAgentBoardApi, resetLocalAgentBoardApi } from './local-agent-board-api';

describe('LocalAgentBoardApi auth management', () => {
  beforeEach(() => {
    resetLocalAgentBoardApi();
  });

  it('creates and lists invites for owner users', async () => {
    const api = getLocalAgentBoardApi();

    const created = await api.createInvite({ email: 'new-member@example.com', role: 'member' });
    expect(created.invite.email).toBe('new-member@example.com');
    expect(created.token).toBeTruthy();

    const invites = await api.listInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0]?.id).toBe(created.invite.id);
    expect(invites[0]?.status).toBe('pending');

    const acceptedSession = await api.acceptInvite({
      inviteId: created.invite.id,
      token: created.token,
      password: 'password123',
      displayName: 'New Member'
    });
    expect(acceptedSession.user.email).toBe('new-member@example.com');
    expect(acceptedSession.memberships[0]?.role).toBe('member');
  });

  it('creates, lists, and revokes personal api tokens', async () => {
    const api = getLocalAgentBoardApi();

    const created = await api.createApiToken({
      name: 'automation token',
      scopes: ['repos:read', 'runs:write']
    });

    expect(created.token).toBeTruthy();
    expect(created.tokenRecord.name).toBe('automation token');

    const listed = await api.listApiTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.tokenRecord.id);

    await api.revokeApiToken(created.tokenRecord.id);

    const listedAfterRevoke = await api.listApiTokens();
    expect(listedAfterRevoke).toHaveLength(0);
  });
});
