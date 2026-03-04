import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSlackSignature } from './verification';
import { handleSlackCommands, handleSlackEvents, handleSlackInteractions } from './handlers';

const tenantAuthDbMocks = vi.hoisted(() => ({
  deleteSlackThreadBinding: vi.fn(),
  getPrimaryTenantId: vi.fn(),
  upsertSlackThreadBinding: vi.fn()
}));

vi.mock('../tenant-auth-db', () => tenantAuthDbMocks);

function createKv(secret: string) {
  const values = new Map<string, string>([['slack/signing-secret', secret]]);
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    }
  };
}

function slackHeaders(timestamp: string, signature: string, teamId = 'T1') {
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
    'x-slack-team-id': teamId
  };
}

function makeEnv(secret = 'secret') {
  return {
    SECRETS_KV: createKv(secret)
  };
}

function taskBinding(taskId: string, channelId: string, threadTs: string) {
  return {
    id: `binding_${taskId}`,
    tenantId: 'tenant_local',
    taskId,
    channelId,
    threadTs,
    latestReviewRound: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('slack handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.getPrimaryTenantId.mockResolvedValue('tenant_local');
    tenantAuthDbMocks.upsertSlackThreadBinding.mockImplementation(async (input: {
      taskId: string;
      channelId: string;
      threadTs: string;
    }) => taskBinding(input.taskId, input.channelId, input.threadTs));
    tenantAuthDbMocks.deleteSlackThreadBinding.mockResolvedValue({ ok: true });
  });

  it('acknowledges slash commands quickly and processes async via waitUntil', async () => {
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix ABC-100',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1'
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('secret', timestamp, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(timestamp, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => {
      waitUntilTasks.push(task);
    });
    const response = await handleSlackCommands(request, makeEnv('secret') as Env, { waitUntil } as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntilTasks).toHaveLength(1);
    await waitUntilTasks[0];
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith({
      tenantId: 'tenant_local',
      taskId: 'issue:ABC-100',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      latestReviewRound: 0
    });
  });

  it('handles repo disambiguation and approve_rerun/pause actions in interactions', async () => {
    const repoDisambiguationPayload = {
      type: 'block_actions',
      user: { id: 'U1' },
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'repo_disambiguation',
          value: JSON.stringify({
            tenantId: 'tenant_local',
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            latestReviewRound: 1,
            repoId: 'repo_alpha'
          })
        }
      ]
    };
    const approvePayload = {
      ...repoDisambiguationPayload,
      actions: [
        {
          action_id: 'approve_rerun',
          value: JSON.stringify({
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            currentRunId: 'run_1',
            latestReviewRound: 2
          })
        }
      ]
    };
    const pausePayload = {
      ...repoDisambiguationPayload,
      actions: [
        {
          action_id: 'pause',
          value: JSON.stringify({
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            latestReviewRound: 3
          })
        }
      ]
    };

    const repoBody = new URLSearchParams({ payload: JSON.stringify(repoDisambiguationPayload) }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const repoSig = await buildSlackSignature('secret', timestamp, repoBody);

    const repoRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(timestamp, repoSig),
      body: repoBody
    });
    const repoResponse = await handleSlackInteractions(repoRequest, makeEnv('secret') as Env);
    expect(await repoResponse.json()).toMatchObject({ ok: true, action: 'repo_disambiguation' });
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith({
      tenantId: 'tenant_local',
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      latestReviewRound: 1
    });

    const approveBody = new URLSearchParams({ payload: JSON.stringify(approvePayload) }).toString();
    const approveSig = await buildSlackSignature('secret', timestamp, approveBody);
    const approveRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(timestamp, approveSig),
      body: approveBody
    });
    const approveResponse = await handleSlackInteractions(approveRequest, makeEnv('secret') as Env);
    expect(await approveResponse.json()).toMatchObject({ ok: true, action: 'approve_rerun' });
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith({
      tenantId: 'tenant_local',
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      currentRunId: 'run_1',
      latestReviewRound: 3
    });

    const pauseBody = new URLSearchParams({ payload: JSON.stringify(pausePayload) }).toString();
    const pauseSig = await buildSlackSignature('secret', timestamp, pauseBody);
    const pauseRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(timestamp, pauseSig),
      body: pauseBody
    });
    const pauseResponse = await handleSlackInteractions(pauseRequest, makeEnv('secret') as Env);
    expect(await pauseResponse.json()).toMatchObject({ ok: true, action: 'pause' });
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith({
      tenantId: 'tenant_local',
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      latestReviewRound: 3
    });
  });

  it('supports close interaction by deleting the thread binding', async () => {
    const payload = {
      type: 'block_actions',
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'close',
          value: JSON.stringify({
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234'
          })
        }
      ]
    };

    const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('secret', timestamp, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(timestamp, signature),
      body: rawBody
    });

    const response = await handleSlackInteractions(request, makeEnv('secret') as Env);
    expect(await response.json()).toMatchObject({ ok: true, action: 'close' });
    expect(tenantAuthDbMocks.deleteSlackThreadBinding).toHaveBeenCalledWith('tenant_local', 'task_1', 'C123');
  });

  it('acknowledges event verification challenge', async () => {
    const event = { type: 'url_verification', challenge: 'challenge-123' };
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('secret', timestamp, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(timestamp, signature),
      body: rawBody
    });
    const response = await handleSlackEvents(request, makeEnv('secret') as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'challenge-123' });
  });
});
