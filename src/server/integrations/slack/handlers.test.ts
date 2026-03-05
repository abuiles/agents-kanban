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
      && String(entry[1].body).includes('I can create this task from *ABC-100*:')
    );
    expect(confirmationThreadPost).toBeTruthy();
    expect(confirmationThreadPost?.[1].body).toContain('Reply `yes` or 👍 to create it');
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

    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);

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
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
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

    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);

    expect(response.status).toBe(200);
    await waitUntilTasks[0];
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
    const calls = vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>;
    const confirmationThreadPost = calls.find((entry) =>
      String(entry[0]).includes('https://slack.com/api/chat.postMessage')
      && String(entry[1].body).includes('"thread_ts":"1672531200.1234"')
      && String(entry[1].body).includes('Stabilize banner rendering on overview')
    );
    expect(confirmationThreadPost).toBeTruthy();
    expect(confirmationThreadPost?.[1].body).toContain('Reply `yes` or 👍 to create it');
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
    expect(calledPayload.text).toContain('/kanvy review <MR_NUMBER|MR_URL>');
    expect(calledPayload.text).toContain('Free-text flow');
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
  });

  it('starts a review-only run from `/kanvy review <number>` when one review repo is available', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review', runId: 'run_review' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha',
        autoReview: {
          enabled: true,
          provider: 'github',
          postInline: false,
          llmAdapter: 'codex',
          llmModel: 'gpt-5.3-codex',
          llmReasoningEffort: 'high',
          codexModel: 'gpt-5.3-codex',
          codexReasoningEffort: 'high'
        }
      } as unknown as { repoId: string; slug: string }
    ]);
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'review 1234',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/review'
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

    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'pull/1234/head',
      autoReviewMode: 'on',
      llmModel: 'gpt-5.3-codex',
      llmReasoningEffort: 'high',
      codexModel: 'gpt-5.3-codex',
      codexReasoningEffort: 'high'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        repoId: 'repo_alpha',
        mode: 'review_only'
      })
    );
    expect(repoBoard.transitionRun).toHaveBeenCalledWith('run_review', expect.objectContaining({
      status: 'PR_OPEN',
      reviewNumber: 1234,
      reviewProvider: 'github',
      branchName: 'pull/1234/head'
    }), 'team_one');
    expect(fetchIssue).not.toHaveBeenCalled();
  });

  it('starts a review-only run from GitHub review URL and resolves repo by URL mapping', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_url', runId: 'run_review_url' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_agents',
        slug: 'abuiles/agents-kanban',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'abuiles/agents-kanban'
      } as unknown as { repoId: string; slug: string }
    ]);
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'review https://github.com/abuiles/agents-kanban/pull/101',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/review-url'
    }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');

    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);
    expect(response.status).toBe(200);
    await waitUntilTasks[0];

    expect(repoBoard.transitionRun).toHaveBeenCalledWith('run_review_url', expect.objectContaining({
      reviewProvider: 'github',
      reviewNumber: 101,
      reviewUrl: 'https://github.com/abuiles/agents-kanban/pull/101'
    }), 'team_one');
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only' })
    );
  });

  it('starts a review-only run from GitLab review URL and resolves repo by URL mapping', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_gitlab', runId: 'run_review_gitlab' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_gitlab',
        slug: 'group/subgroup/minions',
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.example.com',
        projectPath: 'group/subgroup/minions'
      } as unknown as { repoId: string; slug: string }
    ]);
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'review https://gitlab.example.com/group/subgroup/minions/-/merge_requests/88',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/review-gitlab'
    }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');

    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);
    expect(response.status).toBe(200);
    await waitUntilTasks[0];

    expect(repoBoard.transitionRun).toHaveBeenCalledWith('run_review_gitlab', expect.objectContaining({
      reviewProvider: 'gitlab',
      reviewNumber: 88,
      reviewUrl: 'https://gitlab.example.com/group/subgroup/minions/-/merge_requests/88',
      branchName: 'refs/merge-requests/88/head'
    }), 'team_one');
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only' })
    );
  });

  it('requests repo disambiguation for numeric review command when multiple review repos exist', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_amb', runId: 'run_review_amb' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha'
      } as unknown as { repoId: string; slug: string },
      {
        repoId: 'repo_beta',
        slug: 'group/repo-beta',
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.example.com',
        projectPath: 'group/repo-beta'
      } as unknown as { repoId: string; slug: string }
    ]);
    const rawBody = new URLSearchParams({
      command: '/kanvy',
      text: 'review 77',
      channel_id: 'C123',
      thread_ts: '1672531200.1234',
      team_id: 'team_one',
      user_id: 'U1',
      response_url: 'https://hooks.slack.com/commands/review-amb'
    }).toString();
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/commands', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => waitUntilTasks.push(task));
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');

    const response = await handleSlackCommands(request, env, { waitUntil } as unknown as ExecutionContext<unknown>);
    expect(response.status).toBe(200);
    await waitUntilTasks[0];

    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(runOrchestratorMocks.scheduleRunJob).not.toHaveBeenCalled();
    const calls = vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>;
    const disambiguation = calls.find((entry) =>
      String(entry[0]).includes('review-amb')
      && String(entry[1].body).includes('Multiple repositories are available')
      && String(entry[1].body).includes('review_repo_disambiguation')
    );
    expect(disambiguation).toBeTruthy();
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
    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
    expect(tenantAuthDbMocks.upsertSlackIntakeSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: 'team_one',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'active',
      data: expect.objectContaining({
        pendingConfirmation: expect.objectContaining({
          repoId: 'repo_alpha',
          title: 'Improve README'
        })
      })
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

    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    const firstResponse = await handleSlackCommands(firstRequest, env, { waitUntil: firstWaitUntil } as unknown as ExecutionContext<unknown>);
    const secondResponse = await handleSlackCommands(secondRequest, env, { waitUntil: secondWaitUntil } as unknown as ExecutionContext<unknown>);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstWaitUntil).toHaveBeenCalledTimes(1);
    expect(secondWaitUntil).toHaveBeenCalledTimes(1);
    await firstWaitUntilTasks[0];
    await secondWaitUntilTasks[0];

    expect(repoBoard.createTask).not.toHaveBeenCalled();
    expect(repoBoard.startRun).not.toHaveBeenCalled();
    const duplicateCall = (vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>)
      .find((entry) => String(entry[0]).includes('https://hooks.slack.com/commands/response-dup'));
    const duplicateReply = JSON.parse(String(duplicateCall?.[1].body ?? '{}'));
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

  it('starts a review-only run from review_repo_disambiguation interaction', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_action', runId: 'run_review_action' });
    const payload = {
      type: 'block_actions',
      container: { channel_id: 'C123', thread_ts: '1672531200.1234' },
      actions: [
        {
          action_id: 'review_repo_disambiguation',
          value: JSON.stringify({
            tenantId: 'tenant_local',
            channelId: 'C123',
            threadTs: '1672531200.1234',
            repoId: 'repo_alpha',
            reviewNumber: 77,
            reviewProvider: 'github',
            reviewUrl: 'https://github.com/acme/repo-alpha/pull/77'
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
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha',
        autoReview: {
          enabled: true,
          provider: 'github',
          postInline: false,
          llmAdapter: 'codex',
          llmModel: 'gpt-5.3-codex',
          llmReasoningEffort: 'high',
          codexModel: 'gpt-5.3-codex',
          codexReasoningEffort: 'high'
        }
      } as unknown as { repoId: string; slug: string }
    ]);

    const response = await handleSlackInteractions(
      request,
      makeEnv('secret', repoBoard, boardIndex),
      {} as unknown as ExecutionContext<unknown>
    );
    const body = await response.json() as { ok: true; action: string; taskId: string; runId: string; repoId: string };

    expect(body).toMatchObject({
      ok: true,
      action: 'review_repo_disambiguation',
      taskId: 'task_review_action',
      runId: 'run_review_action',
      repoId: 'repo_alpha'
    });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'pull/77/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        repoId: 'repo_alpha',
        mode: 'review_only'
      })
    );
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

  it('starts a review-only run from @kanvy mention in a thread', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_mention', runId: 'run_review_mention' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha'
      } as unknown as { repoId: string; slug: string }
    ]);
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvMentionReview1',
      team_id: 'team_one',
      event: {
        type: 'app_mention',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1235',
        user: 'U1',
        text: '<@U_KANVY> review 12041'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'pull/12041/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', repoId: 'repo_alpha' })
    );
  });

  it('starts a review-only run when @kanvy mention appears mid-message', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_inline_mention', runId: 'run_review_inline_mention' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha'
      } as unknown as { repoId: string; slug: string }
    ]);
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvInlineMentionReview1',
      team_id: 'team_one',
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1236',
        user: 'U1',
        text: 'no, <@U_KANVY> review 12041',
        channel_type: 'channel'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'pull/12041/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', repoId: 'repo_alpha' })
    );
  });

  it('starts a review-only run from @kanvy mention using thread context for review intent', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_context', runId: 'run_review_context' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha',
        autoReview: {
          enabled: true,
          provider: 'github',
          postInline: false
        }
      } as unknown as { repoId: string; slug: string }
    ]);
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    let openAiCalled = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/conversations.replies')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '1772660529.450500', user: 'U1', text: 'Draft MR created for ACME-1234' },
            { ts: '1772660529.450600', user: 'U1', text: 'https://github.com/acme/repo-alpha/pull/12041' },
            { ts: '1772660529.450700', user: 'U2', text: 'Looks good but needs review' }
          ]
        }), { status: 200 });
      }
      if (url.includes('https://api.openai.com/v1/chat/completions')) {
        openAiCalled += 1;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                isReview: true,
                reviewUrl: 'https://github.com/acme/repo-alpha/pull/12041'
              })
            }
          }]
        }), { status: 200 });
      }
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1772660529.450679' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvMentionReviewContext',
      team_id: 'team_one',
      event: {
        type: 'app_mention',
        channel: 'C0AH77Y53NC',
        thread_ts: '1772660529.450679',
        ts: '1772677754.188400',
        user: 'U02MV9VJUGN',
        text: '<@U0AJQ0GPJQL> review this',
        channel_type: 'channel'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(openAiCalled).toBe(0);
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'pull/12041/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', repoId: 'repo_alpha' })
    );
  });

  it('starts a review-only run from @kanvy review this MR using nearby channel MR announcement', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_channel_context', runId: 'run_review_channel_context' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha',
        autoReview: {
          enabled: true,
          provider: 'github',
          postInline: false
        }
      } as unknown as { repoId: string; slug: string }
    ]);
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/conversations.replies')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '1772677754.188369', user: 'U02MV9VJUGN', text: '<@U0AJQ0GPJQL> review this MR' }
          ]
        }), { status: 200 });
      }
      if (url.includes('https://slack.com/api/conversations.history')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '1772660529.450700', user: 'bot', text: 'MR !17 opened: https://github.com/acme/repo-alpha/pull/17' },
            { ts: '1772660529.450701', user: 'U1', text: 'Looks good but needs review' }
          ]
        }), { status: 200 });
      }
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1772677754.188369' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvMentionReviewChannelContext',
      team_id: 'team_one',
      event: {
        type: 'message',
        channel: 'C0AH77Y53NC',
        ts: '1772677754.188369',
        user: 'U02MV9VJUGN',
        text: '<@U0AJQ0GPJQL> review this MR',
        channel_type: 'channel'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_alpha',
      sourceRef: 'pull/17/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', repoId: 'repo_alpha' })
    );
  });

  it('starts a review-only run when @kanvy mention includes a Slack-formatted GitLab MR URL', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_slack_link', runId: 'run_review_slack_link' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_checkout',
        slug: 'engineering/customcheckout',
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.rechargeapps.net',
        projectPath: 'engineering/customcheckout'
      } as unknown as { repoId: string; slug: string }
    ]);
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvMentionReviewSlackLink',
      team_id: 'team_one',
      event: {
        type: 'message',
        channel: 'C0AH77Y53NC',
        thread_ts: '1772660529.450679',
        ts: '1772677754.188369',
        user: 'U02MV9VJUGN',
        text: '<@U0AJQ0GPJQL> review <https://gitlab.rechargeapps.net/engineering/customcheckout/-/merge_requests/31446|31446>',
        channel_type: 'channel'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_checkout',
      sourceRef: 'refs/merge-requests/31446/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', repoId: 'repo_checkout' })
    );
  });

  it('starts review-only run when replying with a repo number after review disambiguation', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_review_reply', runId: 'run_review_reply' });
    const boardIndex = makeBoardIndex([
      {
        repoId: 'repo_alpha',
        slug: 'acme/repo-alpha',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-alpha'
      } as unknown as { repoId: string; slug: string },
      {
        repoId: 'repo_beta',
        slug: 'acme/repo-beta',
        scmProvider: 'github',
        scmBaseUrl: 'https://github.com',
        projectPath: 'acme/repo-beta'
      } as unknown as { repoId: string; slug: string }
    ]);
    const env = makeEnv('secret', repoBoard, boardIndex);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    tenantAuthDbMocks.getSlackIntakeSession.mockResolvedValue({
      id: 'intake_1',
      tenantId: 'tenant_local',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'active',
      turnCount: 1,
      lastConfidence: 1,
      data: {
        pendingReviewSelection: {
          reviewNumber: 77,
          reviewUrl: 'https://github.com/acme/repo-alpha/pull/77',
          choices: ['repo_alpha', 'repo_beta']
        }
      },
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvReviewDisambiguationReply',
      team_id: 'team_one',
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1238',
        user: 'U1',
        text: '2',
        channel_type: 'channel'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(repoBoard.createTask).toHaveBeenCalledWith(expect.objectContaining({
      repoId: 'repo_beta',
      sourceRef: 'pull/77/head',
      autoReviewMode: 'on'
    }));
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'review_only', repoId: 'repo_beta' })
    );
  });

  it('handles @kanvy free-text mention using thread context', async () => {
    const env = makeEnv('secret');
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    tenantAuthDbMocks.getSlackIntakeSession.mockResolvedValue(undefined);
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/conversations.replies')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '1672531200.1000', user: 'U2', text: 'AFCP-3042 — Ready for Review' },
            { ts: '1672531200.1001', user: 'U2', text: 'MR: https://gitlab.example.com/group/repo/-/merge_requests/12041' },
            { ts: '1672531200.1234', user: 'U1', text: '<@U_KANVY> fix this based on this thread' }
          ]
        }), { status: 200 });
      }
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvMentionIntent1',
      team_id: 'team_one',
      event: {
        type: 'app_mention',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1234',
        user: 'U1',
        text: '<@U_KANVY> fix this based on this thread'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'accepted' });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://slack.com/api/conversations.replies'),
      expect.any(Object)
    );
    expect(tenantAuthDbMocks.upsertSlackIntakeSession).toHaveBeenCalled();
  });

  it('posts :eyes: once when intent parsing starts, even if parser retries', async () => {
    const env = makeEnv('secret');
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    tenantAuthDbMocks.getSlackIntakeSession.mockResolvedValue(undefined);
    let llmAttempts = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/conversations.replies')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '1672531200.1000', user: 'U2', text: 'please fix this issue' },
            { ts: '1672531200.1234', user: 'U1', text: '<@U_KANVY> fix this' }
          ]
        }), { status: 200 });
      }
      if (url.includes('/v1/chat/completions')) {
        llmAttempts += 1;
        if (llmAttempts === 1) {
          return new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: 'create_task',
                confidence: 0.42,
                jiraKey: '',
                repoHint: '',
                repoId: '',
                taskTitle: 'Fix issue',
                taskPrompt: 'Fix the issue from the thread.',
                acceptanceCriteria: [],
                missingFields: ['repo'],
                clarifyingQuestion: 'Which repo should I use?'
              })
            }
          }]
        }), { status: 200 });
      }
      if (url.includes('https://slack.com/api/reactions.add')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvMentionEyesRetry1',
      team_id: 'team_one',
      event: {
        type: 'app_mention',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1234',
        user: 'U1',
        text: '<@U_KANVY> fix this'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(llmAttempts).toBe(2);
    const calls = vi.mocked(global.fetch).mock.calls as Array<[RequestInfo | URL, RequestInit]>;
    const eyesReactions = calls.filter((entry) =>
      String(entry[0]).includes('https://slack.com/api/reactions.add')
      && String(entry[1].body).includes('"name":"eyes"')
    );
    expect(eyesReactions).toHaveLength(1);
  });

  it('accepts 👍 as affirmative confirmation for pending task creation', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_emoji_confirm', runId: 'run_emoji_confirm' });
    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    tenantAuthDbMocks.getSlackIntakeSession.mockResolvedValue({
      id: 'intake_confirm',
      tenantId: 'team_one',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'active',
      turnCount: 1,
      data: {
        pendingConfirmation: {
          repoId: 'repo_alpha',
          title: 'Fix issue',
          prompt: 'Fix issue from thread.',
          acceptanceCriteria: ['Issue is fixed']
        }
      },
      lastActivityAt: new Date().toISOString(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('https://slack.com/api/chat.postMessage')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { thread_ts?: string };
        return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ?? '1672531200.1234' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvEmojiConfirm1',
      team_id: 'team_one',
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1240',
        user: 'U1',
        text: '👍'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(repoBoard.createTask).toHaveBeenCalledTimes(1);
    expect(repoBoard.startRun).toHaveBeenCalledTimes(1);
  });

  it('accepts :+1: as affirmative confirmation for pending task creation', async () => {
    const repoBoard = makeRepoBoard({ taskId: 'task_alias_confirm', runId: 'run_alias_confirm' });
    const env = makeEnv('secret', repoBoard);
    await env.SECRETS_KV.put('slack/bot-token', 'xoxb-test');
    tenantAuthDbMocks.getSlackIntakeSession.mockResolvedValue({
      id: 'intake_confirm_alias',
      tenantId: 'team_one',
      channelId: 'C123',
      threadTs: '1672531200.1234',
      status: 'active',
      turnCount: 1,
      data: {
        pendingConfirmation: {
          repoId: 'repo_alpha',
          title: 'Fix issue',
          prompt: 'Fix issue from thread.',
          acceptanceCriteria: ['Issue is fixed']
        }
      },
      lastActivityAt: new Date().toISOString(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '1672531200.1234' }), { status: 200 }));

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvEmojiAliasConfirm1',
      team_id: 'team_one',
      event: {
        type: 'message',
        channel: 'C123',
        thread_ts: '1672531200.1234',
        ts: '1672531200.1241',
        user: 'U1',
        text: ':+1:'
      }
    });
    const signature = await buildSlackSignature('secret', nowTs, rawBody);
    const request = new Request('https://example.test/api/integrations/slack/events', {
      method: 'POST',
      headers: slackHeaders(nowTs, signature),
      body: rawBody
    });

    const response = await handleSlackEvents(request, env);
    expect(response.status).toBe(200);
    expect(repoBoard.createTask).toHaveBeenCalledTimes(1);
    expect(repoBoard.startRun).toHaveBeenCalledTimes(1);
  });
});
