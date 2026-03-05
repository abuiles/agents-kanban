import { beforeEach, describe, expect, it } from 'vitest';
import { getLocalAgentBoardApi, resetLocalAgentBoardApi } from './local-agent-board-api';
import type { RunReviewExecution } from '../domain/types';

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

  it('supports task tag filtering in listTasks', async () => {
    const api = getLocalAgentBoardApi();
    const repo = await api.createRepo({ slug: 'demo/repo', baselineUrl: 'https://example.com' });

    await api.createTask({
      repoId: repo.repoId,
      title: 'Tagged task',
      taskPrompt: 'Do tagged work',
      acceptanceCriteria: ['done'],
      context: { links: [] },
      tags: ['p1', 'backend']
    });
    await api.createTask({
      repoId: repo.repoId,
      title: 'Untagged task',
      taskPrompt: 'Do other work',
      acceptanceCriteria: ['done'],
      context: { links: [] }
    });

    const filtered = await api.listTasks({ repoId: repo.repoId, tags: ['p1'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.title).toBe('Tagged task');
  });

  it('connects terminal to review sandbox when review has completed on terminal-complete runs', async () => {
    const api = getLocalAgentBoardApi();
    await api.rerunReview('run_kpi_1');
    const snapshot = api.getSnapshot();
    const existingReviewExecution = snapshot.runs.find((run) => run.runId === 'run_kpi_1')?.reviewExecution;
    const reviewExecution: RunReviewExecution = {
      enabled: existingReviewExecution?.enabled ?? true,
      trigger: existingReviewExecution?.trigger ?? 'manual_rerun',
      promptSource: existingReviewExecution?.promptSource ?? 'native',
      status: 'completed',
      round: (existingReviewExecution?.round ?? 0) + 1,
      startedAt: existingReviewExecution?.startedAt,
      endedAt: existingReviewExecution?.endedAt,
      durationMs: existingReviewExecution?.durationMs
    };

    snapshot.runs = snapshot.runs.map((run) =>
      run.runId === 'run_kpi_1'
            ? {
                ...run,
                reviewSandboxId: `${run.runId}:review`,
                reviewExecution
            }
        : run
    );

    const bootstrap = await api.getTerminalBootstrap('run_kpi_1', 'review');
    expect(bootstrap.attachable).toBe(true);
    expect(bootstrap.sandboxRole).toBe('review');
    expect(bootstrap.sandboxId).toBe('run_kpi_1:review');
    expect(bootstrap.wsPath).toBe('/api/runs/run_kpi_1/ws?sandboxRole=review');
    expect(bootstrap.sessionName).toBe('operator-run_kpi_1-review');
  });
});
