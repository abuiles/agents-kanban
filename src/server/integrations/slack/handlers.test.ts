import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSlackSignature } from './verification';
import { handleSlackCommands, handleSlackEvents, handleSlackInteractions } from './handlers';

const tenantAuthDbMocks = vi.hoisted(() => ({
  deleteSlackThreadBinding: vi.fn(),
  getPrimaryTenantId: vi.fn(),
  getSlackIntakeSession: vi.fn(),
  listJiraProjectRepoMappingsByProject: vi.fn(),
  listSlackThreadBindings: vi.fn(),
  listIntegrationConfigs: vi.fn(),
  upsertSlackIntakeSession: vi.fn(),
  upsertSlackThreadBinding: vi.fn()
}));

const jiraClientMocks = vi.hoisted(() => ({
  createJiraIssueSourceIntegrationFromEnv: vi.fn()
}));

const runOrchestratorMocks = vi.hoisted(() => ({
  scheduleRunJob: vi.fn()
}));
const fetchSpy = vi.spyOn(globalThis, 'fetch');
const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

vi.mock('../../tenant-auth-db', () => tenantAuthDbMocks);
vi.mock('../jira/client', () => jiraClientMocks);
vi.mock('../../run-orchestrator', () => runOrchestratorMocks);

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

function baseRunStub(taskId: string, runId: string) {
  return {
    runId,
    taskId,
    repoId: 'repo_alpha',
    tenantId: 'tenant_local',
    status: 'WAITING_PREVIEW',
    timeline: [],
    startedAt: '2026-01-01T00:00:00.000Z'
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
    transitionRun: vi.fn(),
    transitionRunFromLoopState: vi.fn(async () => ({ run: baseRunStub(stub.taskId, stub.runId), transitioned: false })),
    requestRunChanges: vi.fn(async () => baseRunStub(stub.taskId, `${stub.runId}_rerun`))
  };
};

function makeBoardIndex(
  repos: Array<{ repoId: string; slug: string }>,
  runToRepoId: Map<string, string> = new Map()
) {
  return {
    getByName: vi.fn(() => ({
      listRepos: vi.fn(async () => repos),
      findRunRepoId: async (runId: string) => runToRepoId.get(runId)
    }))
  };
}

function makeEnv(secret = 'secret', repoBoard = makeRepoBoard({ taskId: 'task_1', runId: 'run_1' }), boardIndex = makeBoardIndex([])) {
  return {
    SECRETS_KV: createKv(secret),
    REPO_BOARD: { getByName: vi.fn(() => repoBoard) },
    BOARD_INDEX: boardIndex,
    OPENAI_API_KEY: 'sk-test'
  } as unknown as Env;
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
    consoleInfoSpy.mockClear();
    tenantAuthDbMocks.getPrimaryTenantId.mockResolvedValue('tenant_local');
    tenantAuthDbMocks.upsertSlackThreadBinding.mockImplementation(async (input: {
      taskId: string;
      channelId: string;
      threadTs: string;
    }) => taskBinding(input.taskId, input.channelId, input.threadTs));
    tenantAuthDbMocks.getSlackIntakeSession.mockResolvedValue(undefined);
    tenantAuthDbMocks.listSlackThreadBindings.mockResolvedValue([]);
    tenantAuthDbMocks.listIntegrationConfigs.mockResolvedValue([]);
    tenantAuthDbMocks.upsertSlackIntakeSession.mockResolvedValue({
      id: 'intake_1',
      tenantId: 'tenant_local',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'active',
      turnCount: 1,
      data: {},
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    tenantAuthDbMocks.deleteSlackThreadBinding.mockResolvedValue({ ok: true });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([]);
    jiraClientMocks.createJiraIssueSourceIntegrationFromEnv.mockReturnValue({
      fetchIssue
    });
    runOrchestratorMocks.scheduleRunJob.mockResolvedValue({ id: 'workflow_1' });
  });

  it('acknowledges slash commands and queues Jira confirmation for single repo mapping', async () => {
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
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        if (payload.thread_ts) {
          return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, ts: '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
    expect(repoBoard.transitionRun).not.toHaveBeenCalled();
    expect(runOrchestratorMocks.scheduleRunJob).not.toHaveBeenCalled();
    const calls = vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>;
    const confirmationThreadPost = calls.find((entry) =>
      String(entry[0]).includes('https://slack.com/api/chat.postMessage')
      && String(entry[1].body).includes('"thread_ts":"1672531200.1234"')
      && String(entry[1].body).includes('I can create this task from ABC-100:')
    );
    expect(confirmationThreadPost?.[1].body).toContain('Reply `yes` to create it');
  });

  it('uses LLM intent detection to route "fix jira issue <KEY>" through Jira fast-path', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_llm_jira', runId: 'run_llm_jira' });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([
      { jiraProjectKey: 'ABC', repoId: 'repo_alpha', priority: 0, active: true, id: 'm1', tenantId: 'tenant_local', createdAt: '', updatedAt: '' }
    ]);
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: 'fix_jira',
                confidence: 0.98,
                jiraKey: 'ABC-100',
                repoHint: '',
                repoId: '',
                taskTitle: '',
                taskPrompt: '',
                acceptanceCriteria: [],
                missingFields: [],
                clarifyingQuestion: ''
              })
            }
          }]
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix jira issue ABC-100',
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

    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard), { waitUntil } as unknown as ExecutionContext<unknown>);

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    expect(fetchIssue).toHaveBeenCalledWith('ABC-100', 'team_one');
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
    expect(tenantAuthDbMocks.upsertSlackIntakeSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: 'team_one',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'active'
    }));
  });

  it('transforms Jira issue content into task payload via LLM when confidence is high', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_jira_transform', runId: 'run_jira_transform' });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([
      { jiraProjectKey: 'ABC', repoId: 'repo_alpha', priority: 0, active: true, id: 'm1', tenantId: 'tenant_local', createdAt: '', updatedAt: '' }
    ]);
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: 'create_task',
                confidence: 0.93,
                jiraKey: '',
                repoHint: '',
                repoId: '',
                taskTitle: 'Stabilize banner rendering on overview',
                taskPrompt: 'Use Jira AFCP-3059 context to implement robust banner rendering with tests.',
                acceptanceCriteria: ['Banner appears on overview', 'No regression on image block'],
                missingFields: [],
                clarifyingQuestion: ''
              })
            }
          }]
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
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
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));

    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard), { waitUntil } as unknown as ExecutionContext<unknown>);

    expect(response.status).toBe(200);
    await waitUntilTasks[0];
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
    const calls = vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>;
    const confirmationResponse = calls.find((entry) => String(entry[0]).includes('https://hooks.slack.com/commands/response'));
    expect(confirmationResponse?.[1].body).toContain('[ABC-100] Stabilize banner rendering on overview');
    expect(confirmationResponse?.[1].body).toContain('Reply `yes` to create it');
  });

  it('uses channel context repo when Jira project mapping is missing', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_ctx_repo', runId: 'run_ctx_repo' });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([]);
    tenantAuthDbMocks.listSlackThreadBindings.mockResolvedValue([
      taskBinding('task_prev', 'C123', '1672531200.1000')
    ]);
    const boardIndex = makeBoardIndex([], new Map([['run_prev', 'repo_alpha']]));
    tenantAuthDbMocks.listSlackThreadBindings.mockResolvedValue([
      {
        ...taskBinding('task_prev', 'C123', '1672531200.1000'),
        currentRunId: 'run_prev'
      }
    ]);
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
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
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');

    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);

    expect(response.status).toBe(200);
    await waitUntilTasks[0];
    expect(tenantAuthDbMocks.upsertSlackIntakeSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: 'team_one',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      data: expect.objectContaining({
        repoId: 'repo_alpha',
        pendingConfirmation: expect.objectContaining({
          repoId: 'repo_alpha'
        })
      })
    }));
  });

  it('responds to /kanvy help with usage guidance and does not start a run', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_help', runId: 'run_help' });
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'help',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/help'
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

    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard), { waitUntil } as unknown as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.text).toContain('Accepted /kanvy command.');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    const calledPayload = JSON.parse(((vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit])[1].body as string));
    expect(calledPayload.text).toContain('/kanvy fix <JIRA_KEY>');
    expect(calledPayload.text).toContain('/kanvy help');
    expect(calledPayload.text).toContain('Free-text flow');
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
  });

  it('supports free-text intake and auto-creates task when parser returns complete intent', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_intake', runId: 'run_intake' });
    tenantAuthDbMocks.listJiraProjectRepoMappingsByProject.mockResolvedValue([]);
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: 'create_task',
                confidence: 0.92,
                repoId: 'repo_alpha',
                taskTitle: 'Improve README',
                taskPrompt: 'Update README structure and examples.',
                acceptanceCriteria: ['README has clearer setup', 'Examples compile'],
                missingFields: []
              })
            }
          }]
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'draft MR for README improvements in repo_alpha',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/response'
    }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));
    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard), { waitUntil } as unknown as ExecutionContext<unknown>);

    expect(response.status).toBe(200);
    await waitUntilTasks[0];
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      title: 'Improve README',
      codexModel: 'gpt-5.1-codex-mini'
    }));
    expect(repoBoard.startRun).toHaveBeenCalledWith('task_intake', { tenantId: 'team_one' });
    expect(tenantAuthDbMocks.upsertSlackIntakeSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: 'team_one',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'completed'
    }));
  });

  it('auto-creates a thread handoff for non-thread free-text slash commands', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_handoff', runId: 'run_handoff' });
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        if (payload.thread_ts) {
          return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, ts: '1672531200.9999' }), { status: 200 });
      }
      if (url.includes('/v1/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: 'create_task',
                confidence: 0.4,
                acceptanceCriteria: [],
                missingFields: ['repo'],
                clarifyingQuestion: 'Which repo should I use?'
              })
            }
          }]
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'investigate flaky tests',
      channel_id: 'C123',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/handoff'
    }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));
    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');

    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);
    expect(response.status).toBe(200);
    await waitUntilTasks[0];

    const calls = vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>;
    const channelKickoff = calls.find((entry) => String(entry[0]).includes('https://slack.com/api/chat.postMessage')
      && !String(entry[1].body).includes('"thread_ts"'));
    const threadPrompt = calls.find((entry) => String(entry[0]).includes('https://slack.com/api/chat.postMessage')
      && String(entry[1].body).includes('"thread_ts":"1672531200.9999"'));
    const responseAck = calls.find((entry) => String(entry[0]).includes('https://hooks.slack.com/commands/handoff'));

    expect(channelKickoff).toBeTruthy();
    expect(threadPrompt).toBeTruthy();
    expect(responseAck?.[1].body).toContain('Continuing in thread:');
    expect(responseAck?.[1].body).toContain('message_ts=1672531200.9999');
    expect(repoBoard.createTask).not.toHaveBeenCalled();
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
    const response = await handleSlackCommands(request, makeEnv('secret'), { waitUntil } as unknown as ExecutionContext<unknown>);
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
    const response = await handleSlackCommands(request, makeEnv('secret', repoBoard, boardIndex), { waitUntil } as unknown as ExecutionContext<unknown>);
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
    const response = await handleSlackCommands(request, makeEnv('secret', failingBoard), { waitUntil } as unknown as ExecutionContext<unknown>);
    const body = await response.json() as { ok: boolean; text: string };

    expect(body.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntilTasks[0];
    const calledPayload = JSON.parse(((vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit])[1].body as string));
    expect(calledPayload.text).toContain('Failed to process /kanvy command for ABC-100');
    expect(calledPayload.text).toContain('temporary outage');
    const lifecycleLogs = consoleInfoSpy.mock.calls
      .map((entry) => String(entry[0]))
      .filter((line) => line.includes('"event":"slack_command_lifecycle"'));
    expect(lifecycleLogs.some((line) => line.includes('"checkpoint":"received"'))).toBe(true);
    expect(lifecycleLogs.some((line) => line.includes('"checkpoint":"jira_fetch_started"'))).toBe(true);
    expect(lifecycleLogs.some((line) => line.includes('"checkpoint":"jira_fetch_failed"'))).toBe(true);
    expect(lifecycleLogs.some((line) => line.includes('"jira_failure_category":"unknown"'))).toBe(true);
    expect(lifecycleLogs.some((line) => line.includes('"issue_key":"ABC-100"'))).toBe(true);
    expect(failingBoard.createTask).not.toHaveBeenCalled();
  });

  it('dedupes duplicate slash command deliveries for the same response url', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_dedupe', runId: 'run_dedupe' });
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
      response_url: 'https://hooks.slack.com/commands/response-dup'
    }).toString();
    const firstTimestamp = Math.floor(Date.now() / 1000).toString();
    const secondTimestamp = (Number(firstTimestamp) + 1).toString();
    const firstSignature = await buildSlackSignature('secret', firstTimestamp, rawBody);
    const secondSignature = await buildSlackSignature('secret', secondTimestamp, rawBody);

    const firstRequest = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(firstTimestamp, firstSignature),
      body: rawBody
    });
    const secondRequest = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(secondTimestamp, secondSignature),
      body: rawBody
    });

    const firstWaitUntilTasks: Array<Promise<unknown>> = [];
    const secondWaitUntilTasks: Array<Promise<unknown>> = [];
    const firstWaitUntil = vi.fn((task: Promise<unknown>) => {
      firstWaitUntilTasks.push(task);
    });
    const secondWaitUntil = vi.fn((task: Promise<unknown>) => {
      secondWaitUntilTasks.push(task);
    });

    const env = makeEnv('secret', repoBoard);
    const firstResponse = await handleSlackCommands(firstRequest, env, { waitUntil: firstWaitUntil } as unknown as ExecutionContext<unknown>);
    const secondResponse = await handleSlackCommands(secondRequest, env, { waitUntil: secondWaitUntil } as unknown as ExecutionContext<unknown>);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstWaitUntil).toHaveBeenCalledTimes(1);
    expect(secondWaitUntil).toHaveBeenCalledTimes(1);
    await firstWaitUntilTasks[0];
    await secondWaitUntilTasks[0];

    expect(repoBoard.createTask).toHaveBeenCalledTimes(1);
    expect(repoBoard.startRun).toHaveBeenCalledTimes(1);
    const duplicateReply = JSON.parse(((vi.mocked(global.fetch).mock.calls[1] as [string, RequestInit])[1].body as string));
    expect(duplicateReply.text).toContain('Duplicate /kanvy command ignored');
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
    const response = await handleSlackInteractions(request, makeEnv('secret', repoBoard), {} as unknown as ExecutionContext<unknown>);
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
      expect.anything(),
      {
        tenantId: 'tenant_local',
        repoId: 'repo_alpha',
        taskId: 'task_interaction',
        runId: 'run_interaction',
        mode: 'full_run'
      }
    );
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_local',
      taskId: 'task_interaction',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      currentRunId: 'run_interaction',
      latestReviewRound: 0
    });
  });

  it('dedupes repeated repo_disambiguation interaction payloads', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_interaction_dedupe', runId: 'run_interaction_dedupe' });
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
    const firstTimestamp = Math.floor(Date.now() / 1000).toString();
    const secondTimestamp = (Number(firstTimestamp) + 1).toString();
    const firstSignature = await buildSlackSignature('secret', firstTimestamp, rawBody);
    const secondSignature = await buildSlackSignature('secret', secondTimestamp, rawBody);
    const firstRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(firstTimestamp, firstSignature),
      body: rawBody
    });
    const secondRequest = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(secondTimestamp, secondSignature),
      body: rawBody
    });

    const env = makeEnv('secret', repoBoard);
    const firstResponse = await handleSlackInteractions(firstRequest, env, {} as unknown as ExecutionContext<unknown>);
    const secondResponse = await handleSlackInteractions(secondRequest, env, {} as unknown as ExecutionContext<unknown>);

    expect(await firstResponse.json()).toMatchObject({
      ok: true,
      action: 'repo_disambiguation',
      taskId: 'task_interaction_dedupe',
      runId: 'run_interaction_dedupe'
    });
    expect(await secondResponse.json()).toMatchObject({
      ok: true,
      status: 'duplicate_interaction_ignored',
      action: 'repo_disambiguation',
      taskId: 'issue:ABC-100'
    });
    expect(repoBoard.createTask).toHaveBeenCalledTimes(1);
    expect(repoBoard.startRun).toHaveBeenCalledTimes(1);
  });

  it('starts a rerun when approve_rerun is clicked in decision-required state', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_1', runId: 'run_1' });
    repoBoard.transitionRunFromLoopState.mockResolvedValueOnce({
      run: baseRunStub('task_1', 'run_1'),
      transitioned: true
    });
    repoBoard.requestRunChanges.mockResolvedValueOnce(baseRunStub('task_1', 'run_2'));

    const payload = {
      type: 'block_actions',
      user: { id: 'U1' },
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'approve_rerun',
          value: JSON.stringify({
            tenantId: 'tenant_local',
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            currentRunId: 'run_1',
            latestReviewRound: 2
          })
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const response = await handleSlackInteractions(
      request,
      makeEnv('secret', repoBoard, makeBoardIndex([], new Map([['run_1', 'repo_alpha']]))),
      {} as unknown as ExecutionContext<unknown>
    );
    expect(await response.json()).toMatchObject({ ok: true, action: 'approve_rerun' });
    expect(repoBoard.transitionRunFromLoopState).toHaveBeenCalledWith(
      'run_1',
      'DECISION_REQUIRED',
      { loopState: 'RERUN_QUEUED' },
      'tenant_local'
    );
    expect(repoBoard.requestRunChanges).toHaveBeenCalledWith(
      'run_1',
      { prompt: 'Slack approved rerun for review round 3.' },
      'tenant_local'
    );
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        tenantId: 'tenant_local',
        repoId: 'repo_alpha',
        taskId: 'task_1',
        runId: 'run_2',
        mode: 'full_run'
      }
    );
    expect(repoBoard.transitionRun).toHaveBeenCalledWith('run_2', {
      loopState: 'RERUN_QUEUED',
      workflowInstanceId: 'workflow_1',
      orchestrationMode: 'workflow'
    });
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_local',
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      currentRunId: 'run_2',
      latestReviewRound: 3
    });
  });

  it('does not start a duplicate rerun when approve_rerun is not in DECISION_REQUIRED', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_1', runId: 'run_1' });
    repoBoard.transitionRunFromLoopState.mockResolvedValueOnce({
      run: baseRunStub('task_1', 'run_1'),
      transitioned: false
    });

    const payload = {
      type: 'block_actions',
      user: { id: 'U1' },
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'approve_rerun',
          value: JSON.stringify({
            tenantId: 'tenant_local',
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            currentRunId: 'run_1',
            latestReviewRound: 2
          })
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const response = await handleSlackInteractions(
      request,
      makeEnv('secret', repoBoard, makeBoardIndex([], new Map([['run_1', 'repo_alpha']]))),
      {} as unknown as ExecutionContext<unknown>
    );
    expect(await response.json()).toMatchObject({ ok: true, action: 'approve_rerun' });
    expect(repoBoard.requestRunChanges).not.toHaveBeenCalled();
    expect(runOrchestratorMocks.scheduleRunJob).not.toHaveBeenCalled();
    expect(repoBoard.transitionRun).not.toHaveBeenCalled();
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).not.toHaveBeenCalled();
  });

  it('pauses current run and preserves the Slack thread binding', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_1', runId: 'run_1' });
    const payload = {
      type: 'block_actions',
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'pause',
          value: JSON.stringify({
            tenantId: 'tenant_local',
            taskId: 'task_1',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            currentRunId: 'run_1',
            latestReviewRound: 3
          })
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const response = await handleSlackInteractions(
      request,
      makeEnv('secret', repoBoard, makeBoardIndex([], new Map([['run_1', 'repo_alpha']]))),
      {} as unknown as ExecutionContext<unknown>
    );
    expect(await response.json()).toMatchObject({ ok: true, action: 'pause' });
    expect(repoBoard.transitionRun).toHaveBeenCalledWith('run_1', { loopState: 'PAUSED' }, 'tenant_local');
    expect(tenantAuthDbMocks.upsertSlackThreadBinding).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_local',
      taskId: 'task_1',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      currentRunId: 'run_1',
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

    const response = await handleSlackInteractions(request, makeEnv('secret'), {} as unknown as ExecutionContext<unknown>);
    expect(await response.json()).toMatchObject({ ok: true, action: 'close' });
    expect(tenantAuthDbMocks.deleteSlackThreadBinding).toHaveBeenCalledWith(expect.anything(), 'tenant_local', 'task_1', 'C123');
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
