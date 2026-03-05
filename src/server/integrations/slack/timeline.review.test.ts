import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../ui/domain/types';
import { mirrorSlackReviewCompletion } from './timeline';

const clientMocks = vi.hoisted(() => ({
  listSlackThreadBindingsForTask: vi.fn(),
  postSlackThreadMessage: vi.fn()
}));

vi.mock('./client', () => clientMocks);

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    tenantId: 'team_one',
    runId: 'run_review_1',
    taskId: 'task_review_1',
    repoId: 'repo_agents',
    status: 'PR_OPEN',
    branchName: 'pull/101/head',
    reviewProvider: 'github',
    reviewNumber: 101,
    reviewUrl: 'https://github.com/abuiles/agents-kanban/pull/101',
    reviewExecution: {
      enabled: true,
      trigger: 'manual_rerun',
      promptSource: 'native',
      status: 'completed',
      round: 1
    },
    reviewFindingsSummary: {
      total: 3,
      open: 2,
      posted: 2,
      provider: 'github'
    },
    errors: [],
    startedAt: '2026-03-04T00:00:00.000Z',
    timeline: [],
    simulationProfile: 'happy_path',
    pendingEvents: [],
    ...overrides
  };
}

function buildEnv() {
  const kv = new Map<string, string>();
  return {
    SECRETS_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      })
    }
  } as unknown as Env;
}

describe('slack review completion mirroring', () => {
  beforeEach(() => {
    clientMocks.listSlackThreadBindingsForTask.mockReset();
    clientMocks.postSlackThreadMessage.mockReset();
  });

  it('posts a concise completion summary to bound Slack thread for review-only tasks', async () => {
    const env = buildEnv();
    clientMocks.listSlackThreadBindingsForTask.mockResolvedValue([
      {
        id: 'binding_1',
        tenantId: 'team_one',
        taskId: 'task_review_1',
        channelId: 'C123',
        threadTs: '1710000000.100',
        currentRunId: 'run_review_1',
        latestReviewRound: 1,
        createdAt: '2026-03-04T00:00:00.000Z',
        updatedAt: '2026-03-04T00:00:00.000Z'
      }
    ]);
    clientMocks.postSlackThreadMessage.mockResolvedValue({ delivered: true, messageTs: '1710000001.100' });

    await mirrorSlackReviewCompletion(
      env,
      buildRun(),
      {
        title: '[Review] PR #101',
        context: { links: [], notes: 'Created from Slack /kanvy review for PR #101.' }
      },
      'run_review_1:review_completed:1'
    );

    expect(clientMocks.postSlackThreadMessage).toHaveBeenCalledTimes(1);
    expect(clientMocks.postSlackThreadMessage).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: 'team_one',
        channelId: 'C123',
        threadTs: '1710000000.100'
      })
    );
    expect(clientMocks.postSlackThreadMessage.mock.calls[0]?.[1]?.text).toContain('Review completed');
    expect(clientMocks.postSlackThreadMessage.mock.calls[0]?.[1]?.text).toContain('left 2 comments');
  });

  it('does not post when task is not a slack review-only task', async () => {
    const env = buildEnv();
    clientMocks.listSlackThreadBindingsForTask.mockResolvedValue([
      {
        id: 'binding_1',
        tenantId: 'team_one',
        taskId: 'task_review_1',
        channelId: 'C123',
        threadTs: '1710000000.100',
        currentRunId: 'run_review_1',
        latestReviewRound: 1,
        createdAt: '2026-03-04T00:00:00.000Z',
        updatedAt: '2026-03-04T00:00:00.000Z'
      }
    ]);

    await mirrorSlackReviewCompletion(
      env,
      buildRun(),
      {
        title: 'Normal task',
        context: { links: [], notes: 'Created from Slack /kanvy intent intake.' }
      },
      'run_review_1:review_completed:1'
    );

    expect(clientMocks.postSlackThreadMessage).not.toHaveBeenCalled();
  });
});
