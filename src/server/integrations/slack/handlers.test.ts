import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSlackSignature } from './verification';
import { handleSlackCommands, handleSlackInteractions } from './handlers';

const tenantAuthDbMocks = vi.hoisted(() => ({
  deleteSlackThreadBinding: vi.fn(),
  getPrimaryTenantId: vi.fn(),
  listJiraProjectRepoMappingsByProject: vi.fn(),
  upsertSlackThreadBinding: vi.fn()
}));

const jiraClientMocks = vi.hoisted(() => ({
  createJiraIssueSourceIntegrationFromEnv: vi.fn()
}));

const runOrchestratorMocks = vi.hoisted(() => ({
  scheduleRunJob: vi.fn()
}));
const fetchSpy = vi.spyOn(globalThis, 'fetch');

vi.mock('../../tenant-auth-db', () => tenantAuthDbMocks);
vi.mock('../jira/client', () => jiraClientMocks);
vi.mock('../run-orchestrator', () => runOrchestratorMocks);

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

function makeRepoBoard(stub: { taskId: string; runId: string }) {
  return {
    createTask: vi.fn().mockResolvedValue({
      taskId: stub.taskId,
      repoId: 'repo_alpha'
    }),
    startRun: vi.fn().mockResolvedValue({
      runId: stub.runId,
      taskId: stub.taskId
    }),
    transitionRun: vi.fn()
  };
};

function makeBoardIndex(repos: Array<{ repoId: string; slug: string }>) {
  return {
    getByName: vi.fn(() => ({
      listRepos: vi.fn(async () => repos)
    }))
  };
}

function makeEnv(secret = 'secret', repoBoard = makeRepoBoard({ taskId: 'task_1', runId: 'run_1' }), boardIndex = makeBoardIndex([])) {
  return {
    SECRETS_KV: createKv(secret),
    REPO_BOARD: { getByName: vi.fn(() => repoBoard) },
    BOARD_INDEX: boardIndex
  };
}

describe('slack handlers', () => {
  const nowTs = Math.floor(Date.now() / 1000).toString();
  const issue = {
    issueKey: 'ABC-100',
    title: 'Cannot login',
    body: 'Button fails',
    url: 'https://jira.test.com/browse/ABC-100'
  };
  const fetchIssue = vi.fn().mockResolvedValue(issue);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    tenantAuthDbMocks.getPrimaryTenantId.mockResolvedValue('tenant_local');
    tenantAuthDbMocks.upsertSlackThreadBinding.mockImplementation(async (input: {
      taskId: string;
      channelId: string;
      threadTs: string;
    }) => taskBinding(input.taskId, input.channelId, input.threadTs));
    tenantAuthDbMocks.deleteSlackThreadBinding.mockResolvedValue({ ok: true });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([]);
    jiraClientMocks.createJiraIssueSourceIntegrationFromEnv.mockReturnValue({
      fetchIssue
    });
    runOrchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'workflow_1' });
  });

  it('acknowledges slash commands and auto-starts task/run for single Jira repo mapping', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_single', runId: 'run_single' });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([
      { jiraProjectKey: 'ABC', repoId: 'repo_alpha', priority: 0, active: true, id: 'm1', tenantId: 'tenant_local', createdAt: '', updatedAt: '' }
    ]);
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix ABC-100',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const timestamp = nowTs;
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
    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard), { waitUntil } as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'main',
      llmAdapter: 'codex',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    }));
    expect(repoBoard.startRun).toHaveBeenCalledWith('task_single', { tenantId: 'tenant_local' });
    expect(repoBoard.transitionRun).toHaveBeenCalledWith('run_single', {
      workflowInstanceId: 'workflow_1',
      orchestrationMode: 'workflow'
    });
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      {
        tenantId: 'tenant_local',
        repoId: 'repo_alpha',
        taskId: 'task_single',
        runId: 'run_single',
        mode: 'full_run'
      },
      expect.anything()
    );
    expect(tenantAuthDbMocks.deleteSlackThreadBinding).toHaveBeenCalledWith('tenant_local', 'issue:ABC-100', 'C123');
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith({
      tenantId: 'tenant_local',
      taskId: 'task_single',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      currentRunId: 'run_single',
      latestReviewRound: 0
    });
  });

  it('asks for repo disambiguation when multiple mappings exist', async () => {
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([
      { jiraProjectKey: 'ABC', repoId: 'repo_alpha', priority: 0, active: true, id: 'm1', tenantId: 'tenant_local', createdAt: '', updatedAt: '' },
      { jiraProjectKey: 'ABC', repoId: 'repo_beta', priority: 1, active: true, id: 'm2', tenantId: 'tenant_local', createdAt: '', updatedAt: '' }
    ]);

    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix ABC-100',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const timestamp = nowTs;
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
    const response = await handleSlackCommands(request, makeEnv('secret'), { waitUntil } as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    const calledPayload = JSON.parse(((vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit])[1].body as string));
    expect(calledPayload.response_type).toBe('ephemeral');
    expect(calledPayload.blocks[1].elements).toHaveLength(2);
    expect(calledPayload.blocks[1].elements[0].action_id).toBe('repo_disambiguation');
  });

  it('returns a clear message when no mappings are resolvable and does not start a run', async () => {
    const boardIndex = makeBoardIndex([
      { repoId: 'repo_alpha', slug: 'alpha' },
      { repoId: 'repo_beta', slug: 'beta' }
    ]);
    const repoBoard = makeRepoBoard({ taskId: 'task_none', runId: 'run_none' });
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix ABC-100',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const timestamp = nowTs;
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
    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard, boardIndex), { waitUntil } as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    const calledPayload = JSON.parse(((vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit])[1].body as string));
    expect(calledPayload.text).toContain('No active mapping exists for project ABC.');
    expect(calledPayload.blocks[1].elements).toHaveLength(2);
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
  });

  it('returns clear Jira read failure responses and does not create tasks', async () => {
    const failingBoard = makeRepoBoard({ taskId: 'task_fail', runId: 'run_fail' });
    jiraClientMocks.createJiraIssueSourceIntegrationFromEnv.mockReturnValue({
      fetchIssue: vi.fn().mockRejectedValue(new Error('temporary outage'))
    });

    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix ABC-100',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const timestamp = nowTs;
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
    const response = await handleSlackCommands(request, makeEnv('secret', failingBoard), { waitUntil } as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    const calledPayload = JSON.parse(((vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit])[1].body as string));
    expect(calledPayload.text).toContain('Failed to process /kanvy command for ABC-100');
    expect(calledPayload.text).toContain('temporary outage');
    expect(failingBoard.createTask).not.toHaveBeenCalled();
  });

  it('starts task/run from repo_disambiguation interaction', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_interaction', runId: 'run_interaction' });
    const payload = {
      type: 'block_actions',
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'repo_disambiguation',
          value: JSON.stringify({
            tenantId: 'tenant_local',
            taskId: 'issue:ABC-100',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            issueKey: 'ABC-100',
            issueTitle: 'Cannot login',
            issueBody: 'Button fails',
            issueUrl: 'https://jira.test.com/browse/ABC-100',
            repoId: 'repo_alpha'
          })
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const timestamp = nowTs;
    const signature = await buildSlackSignature('secret', timestamp, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(timestamp, signature),
      body: rawBody
    });
    const response = await handleSlackInteractions(request, makeEnv('secret', repoBoard), {} as ExecutionContext<unknown>);
    const responseBody = await response.json() as { ok: true; action: string; taskId: string; runId: string; repoId: string };

    expect(responseBody).toMatchObject({
      ok: true,
      action: 'repo_disambiguation',
      taskId: 'task_interaction',
      runId: 'run_interaction',
      repoId: 'repo_alpha'
    });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'main'
    }));
    expect(repoBoard.startRun).toHaveBeenCalledWith('task_interaction', { tenantId: 'tenant_local' });
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      {
        tenantId: 'tenant_local',
        repoId: 'repo_alpha',
        taskId: 'task_interaction',
        runId: 'run_interaction',
        mode: 'full_run'
      },
      expect.anything()
    );
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith({
      tenantId: 'tenant_local',
      taskId: 'task_interaction',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      currentRunId: 'run_interaction',
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
            taskId: 'issue:ABC-100',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            issueKey: 'ABC-100',
            issueTitle: 'Cannot login',
            issueBody: 'Button fails',
            issueUrl: 'https://jira.test.com/browse/ABC-100',
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
    const repoSig = await buildSlackSignature('secret', nowTs, repoBody);

    const repoRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(nowTs, repoSig),
      body: repoBody
    });
    const repoResponse = await handleSlackInteractions(repoRequest, makeEnv('secret'), {} as ExecutionContext<unknown>);
    expect(await repoResponse.json()).toMatchObject({ ok: true, action: 'repo_disambiguation' });

    const approveBody = new URLSearchParams({ payload: JSON.stringify(approvePayload) }).toString();
    const approveSig = await buildSlackSignature('secret', nowTs, approveBody);
    const approveRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(nowTs, approveSig),
      body: approveBody
    });
    const approveResponse = await handleSlackInteractions(approveRequest, makeEnv('secret'), {} as ExecutionContext<unknown>);
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
    const pauseSig = await buildSlackSignature('secret', nowTs, pauseBody);
    const pauseRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(nowTs, pauseSig),
      body: pauseBody
    });
    const pauseResponse = await handleSlackInteractions(pauseRequest, makeEnv('secret'), {} as ExecutionContext<unknown>);
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
    const timestamp = nowTs;
    const signature = await buildSlackSignature('secret', timestamp, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(timestamp, signature),
      body: rawBody
    });

    const response = await handleSlackInteractions(request, makeEnv('secret'), {} as ExecutionContext<unknown>);
    expect(await response.json()).toMatchObject({ ok: true, action: 'close' });
    expect(tenantAuthDbMocks.deleteSlackThreadBinding).toHaveBeenCalledWith('tenant_local', 'task_1', 'C123');
  });

  it('acknowledges event verification challenge', async () => {
    const event = { type: 'url_verification', challenge: 'challenge-123' };
    const rawBody = JSON.stringify(event);
    const timestamp = nowTs;
    const signature = await buildSlackSignature('secret', timestamp, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(timestamp, signature),
      body: rawBody
    });
    const response = await handleSlackEvents(request, makeEnv('secret'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'challenge-123' });
  });
});
