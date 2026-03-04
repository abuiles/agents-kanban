import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => {
  const bindings = new Map<string, {
    tenantId: string;
    taskId: string;
    channelId: string;
    threadTs: string;
    currentRunId?: string;
    latestReviewRound: number;
  }>();
  return {
    bindings,
    deleteSlackThreadBinding: vi.fn(async (_env: Env, tenantId: string, taskId: string, channelId: string) => {
      bindings.delete(`${tenantId}:${taskId}:${channelId}`);
      return { ok: true };
    }),
    getPrimaryTenantId: vi.fn(async () => 'tenant_local'),
    getSlackIntakeSession: vi.fn(async () => undefined),
    listJiraProjectRepoMappingsByProject: vi.fn(async () => ([
      {
        id: 'mapping_1',
        tenantId: 'tenant_local',
        jiraProjectKey: 'ABC',
        repoId: 'repo_gitlab',
        priority: 0,
        active: true,
        createdAt: '',
        updatedAt: ''
      }
    ])),
    listIntegrationConfigs: vi.fn(async () => []),
    upsertSlackIntakeSession: vi.fn(async () => ({
      id: 'intake_1',
      tenantId: 'tenant_local',
      channelId: 'C_ENG',
      threadTs: '1710000000.100',
      status: 'active',
      turnCount: 1,
      data: {},
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })),
    upsertSlackThreadBinding: vi.fn(async (_env: Env, input: {
      tenantId: string;
      taskId: string;
      channelId: string;
      threadTs: string;
      currentRunId?: string;
      latestReviewRound?: number;
    }) => {
      const binding = {
        tenantId: input.tenantId,
        taskId: input.taskId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        currentRunId: input.currentRunId,
        latestReviewRound: input.latestReviewRound ?? 0
      };
      bindings.set(`${input.tenantId}:${input.taskId}:${input.channelId}`, binding);
      return binding;
    })
  };
});

const jiraClientMocks = vi.hoisted(() => ({
  createJiraIssueSourceIntegrationFromEnv: vi.fn()
}));

const runOrchestratorMocks = vi.hoisted(() => ({
  scheduleRunJob: vi.fn()
}));

const slackClientMocks = vi.hoisted(() => ({
  listSlackThreadBindingsForTask: vi.fn(),
  postSlackThreadMessage: vi.fn(async () => ({ delivered: true }))
}));

vi.mock('../tenant-auth-db', () => tenantAuthDbMocks);
vi.mock('./jira/client', () => jiraClientMocks);
vi.mock('../run-orchestrator', () => runOrchestratorMocks);
vi.mock('./slack/client', () => slackClientMocks);

import { buildSlackSignature } from './slack/verification';
import { handleSlackCommands, handleSlackInteractions } from './slack/handlers';
import { handleGitlabWebhook } from './gitlab/handlers';

type RunRecord = {
  runId: string;
  taskId: string;
  repoId: string;
  tenantId: string;
  status: string;
  timeline: unknown[];
  startedAt: string;
  loopState?: string;
  reviewNumber?: number;
  reviewUrl?: string;
};

class KvStore {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }
}

function slackHeaders(timestamp: string, signature: string, teamId = 'team_one') {
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
    'x-slack-team-id': teamId
  };
}

function createRepoBoardState() {
  const state = {
    taskSeq: 0,
    runSeq: 0,
    tasks: [] as Array<{ taskId: string; repoId: string; title: string }>,
    runs: [] as RunRecord[]
  };

  const board = {
    createTask: vi.fn(async (payload: { repoId: string; title: string }) => {
      state.taskSeq += 1;
      const taskId = `task_${state.taskSeq}`;
      state.tasks.push({ taskId, repoId: payload.repoId, title: payload.title });
      return { taskId, repoId: payload.repoId };
    }),
    startRun: vi.fn(async (taskId: string, input: { tenantId: string }) => {
      state.runSeq += 1;
      const runId = `run_${state.runSeq}`;
      const task = state.tasks.find((candidate) => candidate.taskId === taskId);
      const run: RunRecord = {
        runId,
        taskId,
        repoId: task?.repoId ?? 'repo_gitlab',
        tenantId: input.tenantId,
        status: 'QUEUED',
        timeline: [],
        startedAt: `2026-03-04T00:00:0${state.runSeq}.000Z`,
        loopState: 'RUNNING'
      };
      state.runs.push(run);
      return { runId, taskId };
    }),
    getBoardSlice: vi.fn(async () => ({ runs: [...state.runs] })),
    transitionRun: vi.fn(async (runId: string, patch: Partial<RunRecord> & Record<string, unknown>) => {
      const run = state.runs.find((candidate) => candidate.runId === runId);
      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }
      Object.assign(run, patch);
      return run;
    }),
    transitionRunFromLoopState: vi.fn(async (
      runId: string,
      currentLoopState: string,
      patch: Partial<RunRecord>,
      _tenantId: string
    ) => {
      const run = state.runs.find((candidate) => candidate.runId === runId);
      if (!run || run.loopState !== currentLoopState) {
        return { run, transitioned: false };
      }
      Object.assign(run, patch);
      return { run, transitioned: true };
    }),
    requestRunChanges: vi.fn(async (runId: string, _input: { prompt: string }, tenantId: string) => {
      const current = state.runs.find((candidate) => candidate.runId === runId);
      if (!current) {
        throw new Error(`Run ${runId} not found`);
      }
      state.runSeq += 1;
      const rerun: RunRecord = {
        runId: `run_${state.runSeq}`,
        taskId: current.taskId,
        repoId: current.repoId,
        tenantId,
        status: 'QUEUED',
        timeline: [],
        startedAt: `2026-03-04T00:00:0${state.runSeq}.000Z`,
        loopState: 'RERUN_QUEUED',
        reviewNumber: current.reviewNumber,
        reviewUrl: current.reviewUrl
      };
      state.runs.push(rerun);
      return rerun;
    })
  };

  return { state, board };
}

function createEnv(kv: KvStore, board: ReturnType<typeof createRepoBoardState>['board']) {
  return {
    SECRETS_KV: kv as unknown as KVNamespace,
    REPO_BOARD: {
      getByName: vi.fn(() => board)
    },
    BOARD_INDEX: {
      getByName: vi.fn(() => ({
        listRepos: vi.fn(async () => ([
          {
            repoId: 'repo_gitlab',
            tenantId: 'tenant_local',
            slug: 'group/project',
            scmProvider: 'gitlab',
            scmBaseUrl: 'https://gitlab.example',
            projectPath: 'group/project'
          }
        ])),
        findRunRepoId: vi.fn(async (runId: string) => {
          const run = boardState.state.runs.find((candidate) => candidate.runId === runId);
          return run?.repoId;
        })
      }))
    }
  } as unknown as Env;
}

let boardState: ReturnType<typeof createRepoBoardState>;

describe('slack -> jira -> gitlab -> approve rerun mvp flow', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.bindings.clear();
    boardState = createRepoBoardState();
    runOrchestratorMocks.scheduleRunJob
      .mockResolvedValueOnce({ id: 'workflow_1' })
      .mockResolvedValueOnce({ id: 'workflow_2' });
    jiraClientMocks.createJiraIssueSourceIntegrationFromEnv.mockReturnValue({
      fetchIssue: vi.fn(async () => ({
        issueKey: 'ABC-100',
        title: 'Fix login race',
        body: 'Repro in staging with OAuth callback.',
        url: 'https://jira.example.com/browse/ABC-100'
      }))
    });
    slackClientMocks.listSlackThreadBindingsForTask.mockImplementation(async (_env: Env, tenantId: string, taskId: string) => {
      return [...tenantAuthDbMocks.bindings.values()]
        .filter((binding) => binding.tenantId === tenantId && binding.taskId === taskId);
    });
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  });

  it('covers slash command through feedback and approved rerun in one thread', async () => {
    const kv = new KvStore();
    kv.values.set('slack/signing-secret', 'slack-secret');
    kv.values.set('gitlab/webhook-secret', 'gitlab-secret');
    const env = createEnv(kv, boardState.board);

    const slashBody = new URLSearchParams({
      command: '/kanvy',
      text: 'fix ABC-100',
      channel_id: 'C_ENG',
      thread_ts: '1710000000.100',
      team_id: 'team_one',
      user_id: 'U_1',
      response_url: 'https://hooks.slack.com/commands/flow'
    }).toString();
    const slashTs = Math.floor(Date.now() / 1000).toString();
    const slashSig = await buildSlackSignature('slack-secret', slashTs, slashBody);
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const slashResponse = await handleSlackCommands(
      new Request('https://example.test/api/integrations/slack/commands', {
        method: 'POST',
        headers: slackHeaders(slashTs, slashSig),
        body: slashBody
      }),
      env,
      {
        waitUntil: (task: Promise<unknown>) => {
          waitUntilTasks.push(task);
        }
      } as unknown as ExecutionContext<unknown>
    );

    expect(slashResponse.status).toBe(200);
    expect(waitUntilTasks).toHaveLength(1);
    await waitUntilTasks[0];

    expect(boardState.board.createTask).toHaveBeenCalledTimes(1);
    expect(boardState.board.startRun).toHaveBeenCalledTimes(1);
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        mode: 'full_run',
        repoId: 'repo_gitlab',
        taskId: 'task_1',
        runId: 'run_1'
      })
    );

    await boardState.board.transitionRun('run_1', {
      status: 'PR_OPEN',
      reviewNumber: 42,
      reviewUrl: 'https://gitlab.example/group/project/-/merge_requests/42',
      loopState: 'MR_OPEN'
    });

    const pendingResponse = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'gitlab-secret',
        'x-gitlab-event-uuid': 'evt_pending_1'
      },
      body: JSON.stringify({
        object_kind: 'merge_request',
        project: { path_with_namespace: 'group/project' },
        object_attributes: {
          iid: 42,
          action: 'open',
          state: 'opened',
          url: 'https://gitlab.example/group/project/-/merge_requests/42'
        }
      })
    }), env);

    expect(pendingResponse.status).toBe(200);
    expect(await pendingResponse.json()).toMatchObject({ status: 'mirrored_review_pending', runId: 'run_1' });

    const feedbackResponse = await handleGitlabWebhook(new Request('https://example.test/api/integrations/gitlab/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'gitlab-secret',
        'x-gitlab-event-uuid': 'evt_feedback_1'
      },
      body: JSON.stringify({
        object_kind: 'note',
        project: { path_with_namespace: 'group/project' },
        merge_request: { iid: 42, web_url: 'https://gitlab.example/group/project/-/merge_requests/42' },
        user: { username: 'reviewer_1' },
        object_attributes: {
          id: 900,
          note: 'Please add regression tests around the login callback.',
          noteable_type: 'MergeRequest',
          system: false
        }
      })
    }), env);

    expect(feedbackResponse.status).toBe(200);
    expect(await feedbackResponse.json()).toMatchObject({ status: 'mirrored_feedback', runId: 'run_1' });
    expect(boardState.state.runs.find((run) => run.runId === 'run_1')?.loopState).toBe('DECISION_REQUIRED');
    expect(slackClientMocks.postSlackThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: 'C_ENG',
        threadTs: '1710000000.100'
      })
    );

    const interactionPayload = {
      type: 'block_actions',
      team: { id: 'team_one' },
      container: { channel_id: 'C_ENG', thread_ts: '1710000000.100' },
      actions: [
        {
          action_id: 'approve_rerun',
          value: JSON.stringify({
            tenantId: 'team_one',
            taskId: 'task_1',
            channelId: 'C_ENG',
            threadTs: '1710000000.100',
            currentRunId: 'run_1',
            latestReviewRound: 0
          })
        }
      ]
    };
    const interactionBody = new URLSearchParams({ payload: JSON.stringify(interactionPayload) }).toString();
    const interactionTs = (Number(slashTs) + 2).toString();
    const interactionSig = await buildSlackSignature('slack-secret', interactionTs, interactionBody);

    const approveResponse = await handleSlackInteractions(new Request('https://example.test/api/integrations/slack/interactions', {
      method: 'POST',
      headers: slackHeaders(interactionTs, interactionSig),
      body: interactionBody
    }), env, {} as unknown as ExecutionContext<unknown>);

    expect(approveResponse.status).toBe(200);
    expect(await approveResponse.json()).toMatchObject({ ok: true, action: 'approve_rerun', taskId: 'task_1' });
    expect(boardState.board.requestRunChanges).toHaveBeenCalledWith(
      'run_1',
      { prompt: 'Slack approved rerun for review round 1.' },
      'team_one'
    );
    expect(runOrchestratorMocks.scheduleRunJob).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      {
        tenantId: 'team_one',
        repoId: 'repo_gitlab',
        taskId: 'task_1',
        runId: 'run_2',
        mode: 'full_run'
      }
    );
    expect(tenantAuthDbMocks.bindings.get('team_one:task_1:C_ENG')).toMatchObject({
      currentRunId: 'run_2',
      latestReviewRound: 1
    });
  });
});
