import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo, RunCommand, RunError, RunEvent, RunLogEntry, Task } from '../ui/domain/types';
import { createRealRun, applyRunTransition, appendRunError } from './shared/real-run';
import { normalizeOperatorSession, normalizeRunLlmState } from '../shared/llm';

type SandboxEvent = Record<string, unknown>;

type FakeSandbox = {
  writes: Array<{ path: string; contents: string }>;
  commands: string[];
  currentHead: string;
  startProcessCommand?: string;
  gitCheckout: (cloneUrl: string, options: { branch: string; targetDir: string }) => Promise<void>;
  writeFile: (path: string, contents: string) => Promise<void>;
  exec: (command: string) => Promise<{ success: boolean; exitCode: number; stdout?: string; stderr?: string }>;
  startProcess: (command: string) => Promise<{ id: string }>;
  streamProcessLogs: (_processId: string) => Promise<AsyncIterable<SandboxEvent>>;
  killProcess: (_processId: string) => Promise<void>;
};

const sandboxState: { current: FakeSandbox | undefined } = { current: undefined };
const scmState: {
  current:
    | {
        provider: 'github';
        buildCloneUrl: (repo: Repo, credential: { token: string }) => string;
        inferSourceRefFromTask: () => undefined;
        normalizeSourceRef: (sourceRef: string) => { kind: 'branch'; value: string; label: string };
        createReviewRequest: () => Promise<{ provider: 'github'; number: number; url: string }>;
        upsertRunComment: () => Promise<void>;
        getReviewState: () => Promise<{ exists: boolean }>;
        listCommitChecks: () => Promise<[]>;
        isCommitOnDefaultBranch: () => Promise<boolean>;
      }
    | undefined;
} = { current: undefined };
const usageLedgerWritesState: { entries: Array<Record<string, unknown>> } = { entries: [] };

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: () => {
    if (!sandboxState.current) {
      throw new Error('Sandbox was not configured for this test.');
    }
    return sandboxState.current;
  },
  parseSSEStream: <T>(stream: AsyncIterable<T> | Iterable<T>) => ({
    async *[Symbol.asyncIterator]() {
      for await (const event of stream as AsyncIterable<T>) {
        yield event;
      }
    }
  })
}));

vi.mock('./scm/registry', () => ({
  getScmAdapter: () => {
    if (!scmState.current) {
      throw new Error('SCM adapter was not configured for this test.');
    }
    return scmState.current;
  }
}));

vi.mock('./usage-ledger', () => ({
  writeUsageLedgerEntriesBestEffort: async (_env: Env, entries: Array<Record<string, unknown>>) => {
    usageLedgerWritesState.entries.push(...entries);
  }
}));

import { executeRunJob } from './run-orchestrator';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_1',
    slug: 'abuiles/minions',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'abuiles/minions',
    defaultBranch: 'main',
    baselineUrl: 'https://minions.example.com',
    enabled: true,
    previewMode: 'skip',
    evidenceMode: 'skip',
    checkpointConfig: {
      enabled: false,
      triggerMode: 'phase_boundary',
      contextNotes: {
        enabled: true,
        filePath: '.agentskanban/context/run-context.md',
        cleanupBeforeReview: true
      },
      reviewPrep: {
        squashBeforeFirstReviewOpen: true,
        rewriteOnChangeRequestRerun: false
      }
    },
    llmAuthBundleR2Key: 'llm-auth-bundle',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task_1',
    repoId: 'repo_1',
    title: 'Adapter seam regression',
    taskPrompt: 'Add focused adapter coverage.',
    acceptanceCriteria: ['Adapter path is covered'],
    context: { links: [] },
    status: 'ACTIVE',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildSandbox(events: SandboxEvent[]): FakeSandbox {
  const currentHead = { value: 'a'.repeat(40) };

  return {
    writes: [],
    commands: [],
    currentHead: currentHead.value,
    async gitCheckout() {},
    async writeFile(path, contents) {
      this.writes.push({ path, contents });
    },
    async exec(command) {
      this.commands.push(command);

      if (command.includes('npm install -g @openai/codex') || command.includes('npm install -g @cursor/cli')) {
        return { success: true, exitCode: 0, stdout: '' };
      }
      if (command.includes('base64 -d /workspace/codex-auth.tgz.b64')) {
        return { success: true, exitCode: 0, stdout: '.codex\n' };
      }
      if (command.includes('Cloudflare MCP: configured')) {
        return { success: true, exitCode: 0, stdout: 'Codex config file: /root/.codex/config.toml\nCloudflare MCP: configured\n' };
      }
      if (command.includes('node /workspace/codex-auth-diagnostics.mjs')) {
        return {
          success: true,
          exitCode: 0,
          stdout: [
            'HOME=/root',
            'Codex dir: present',
            'Codex auth file: /root/.codex/auth.json',
            'Codex config file: /root/.codex/config.toml',
            'Cloudflare MCP configured: yes',
            'Codex OPENAI_API_KEY present: yes'
          ].join('\n')
        };
      }
      if (command.includes('codex --version')) {
        return { success: true, exitCode: 0, stdout: '/usr/local/bin/codex\n0.0.1\n' };
      }
      if (command.includes('Cursor model:')) {
        return { success: true, exitCode: 0, stdout: '0.0.1\nCursor model: cursor-default\nCursor reasoning effort: medium\n' };
      }
      if (command.includes("git config user.name 'AgentsKanban'")) {
        return { success: true, exitCode: 0, stdout: '' };
      }
      if (command.includes('git checkout -b')) {
        return { success: true, exitCode: 0, stdout: 'Switched to a new branch\n' };
      }
      if (command.includes('git branch --show-current')) {
        return { success: true, exitCode: 0, stdout: 'agent/task_1/run_1\n' };
      }
      if (command.includes('git status --short')) {
        return { success: true, exitCode: 0, stdout: 'M src/index.ts\n' };
      }
      if (command.includes('git rev-parse origin/main')) {
        return { success: true, exitCode: 0, stdout: 'a'.repeat(40) };
      }
      if (command.includes('git merge-base HEAD origin/main')) {
        return { success: true, exitCode: 0, stdout: 'a'.repeat(40) };
      }
      if (command.includes('git rev-parse HEAD')) {
        return { success: true, exitCode: 0, stdout: currentHead.value };
      }
      if (command.includes('git reset --soft')) {
        currentHead.value = 'a'.repeat(40);
        this.currentHead = currentHead.value;
        return { success: true, exitCode: 0, stdout: '' };
      }
      if (command.includes('git cat-file -e HEAD:')) {
        return {
          success: false,
          exitCode: 128,
          stderr: 'fatal: path does not exist in HEAD'
        };
      }
      if (command.includes('git add -A && git commit -m')) {
        currentHead.value = 'b'.repeat(40);
        this.currentHead = currentHead.value;
        return { success: true, exitCode: 0, stdout: '[agent/task_1/run_1] commit\n' };
      }

      return { success: true, exitCode: 0, stdout: '' };
    },
    async startProcess(command) {
      this.startProcessCommand = command;
      return { id: 'proc_1' };
    },
    async streamProcessLogs() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event;
          }
        }
      };
    },
    async killProcess() {}
  };
}

function createHarness(task: Task, repo: Repo) {
  const logs: RunLogEntry[] = [];
  const events: RunEvent[] = [];
  const commands: RunCommand[] = [];
  let run = createRealRun(task, 'run_1', new Date('2026-03-02T00:00:00.000Z'));

  const repoBoard = {
    async getTask() {
      return { task };
    },
    async getRun() {
      return run;
    },
    async appendRunLogs(_runId: string, entries: RunLogEntry[]) {
      logs.push(...entries);
    },
    async appendRunEvents(_runId: string, entries: RunEvent[]) {
      events.push(...entries);
    },
    async upsertRunCommands(_runId: string, next: RunCommand[]) {
      for (const command of next) {
        const index = commands.findIndex((candidate) => candidate.id === command.id);
        if (index >= 0) {
          commands[index] = command;
        } else {
          commands.push(command);
        }
      }
    },
    async transitionRun(_runId: string, patch: Record<string, unknown> & { appendTimelineNote?: string }) {
      run = applyRunTransition(run, patch, new Date().toISOString());
      return run;
    },
    async updateOperatorSession(_runId: string, session?: Parameters<typeof normalizeOperatorSession>[0]) {
      run = normalizeRunLlmState({
        ...run,
        operatorSession: normalizeOperatorSession(session)
      });
      return run;
    },
    async markRunFailed(_runId: string, error: RunError) {
      run = appendRunError(run, error, error.at);
      return run;
    }
  };

  const board = {
    async getRepo() {
      return repo;
    },
    async getScmCredentialSecret() {
      return undefined;
    }
  };

  const env = {
    Sandbox: {},
    REPO_BOARD: { getByName: () => repoBoard },
    BOARD_INDEX: { getByName: () => board },
    GITHUB_TOKEN: 'ghp_test_1234',
    OPENAI_API_KEY: 'sk-test-1234',
    CODEX_AUTH_BUNDLE_R2_KEY: 'auth/codex-auth.tgz',
    RUN_ARTIFACTS: {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode('bundle').buffer
      }),
      put: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as Env;

  return {
    env,
    repoBoard,
    getRun: () => run,
    logs,
    events,
    commands
  };
}

beforeEach(() => {
  usageLedgerWritesState.entries = [];
  scmState.current = {
    provider: 'github',
    buildCloneUrl: (_repo, credential) => `https://x-access-token:${credential.token}@github.com/abuiles/minions.git`,
    inferSourceRefFromTask: () => undefined,
    normalizeSourceRef: (sourceRef) => ({ kind: 'branch', value: sourceRef, label: sourceRef }),
    createReviewRequest: async () => ({
      provider: 'github',
      number: 17,
      url: 'https://github.com/abuiles/minions/pull/17'
    }),
    upsertRunComment: async () => {},
    getReviewState: async () => ({ exists: true }),
    listCommitChecks: async () => [],
    isCommitOnDefaultBranch: async () => true
  };
});

describe('executeRunJob LLM adapter coverage', () => {
  it('auto-runs review on REVIEW entry when enabled', async () => {
    const task = buildTask({
      sourceRef: 'https://jira.example.com/browse/AK-123',
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      autoReview: {
        enabled: true,
        provider: 'jira',
        postInline: false
      }
    });
    const harness = createHarness(task, repo);
    (harness.env as unknown as { JIRA_TOKEN?: string }).JIRA_TOKEN = 'jira-token-test';
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        return {
          success: true,
          exitCode: 0,
          stdout: '\n===CODEX_LAST_MESSAGE===\n{"findings":[{"severity":"high","title":"Missing empty state guard","description":"Add a guard for null payloads.","filePath":"src/index.ts","lineStart":12}]}\n'
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/api/2/issue/AK-123/comment') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: '301' }), { status: 200 });
      }
      if (url.includes('/rest/api/2/issue/AK-123/comment')) {
        return new Response(JSON.stringify({ comments: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().reviewExecution).toMatchObject({
      enabled: true,
      trigger: 'auto_on_review',
      status: 'completed',
      round: 1,
      promptSource: 'native'
    });
    expect(harness.getRun().reviewFindingsSummary).toMatchObject({
      total: 1,
      open: 1,
      posted: 1,
      provider: 'jira'
    });
    expect(harness.getRun().reviewPostState).toMatchObject({
      provider: 'jira',
      status: 'completed',
      postedCount: 1,
      findingsCount: 1
    });
    expect(harness.getRun().reviewArtifacts).toEqual({
      findingsJsonKey: 'tenants/tenant_legacy/runs/run_1/review/findings.json',
      reviewMarkdownKey: 'tenants/tenant_legacy/runs/run_1/review/review-findings.md'
    });
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Auto review started (round 1).'))).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Review completed (round 1; 1 findings, 1 posted).'))).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.status === 'PR_OPEN')).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Pull request opened.'))).toBe(true);
  });

  it('supports manual review-only rerun and increments review round', async () => {
    const task = buildTask({
      sourceRef: 'https://jira.example.com/browse/AK-123',
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      autoReview: {
        enabled: true,
        provider: 'jira',
        postInline: false
      }
    });
    const harness = createHarness(task, repo);
    (harness.env as unknown as { JIRA_TOKEN?: string }).JIRA_TOKEN = 'jira-token-test';
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        return {
          success: true,
          exitCode: 0,
          stdout: '\n===CODEX_LAST_MESSAGE===\n{"findings":[{"severity":"low","title":"Follow-up formatting issue","description":"Whitespace should be consistent.","filePath":"src/styles.ts","lineStart":4}]}\n'
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/api/2/issue/AK-123/comment') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: '301' }), { status: 200 });
      }
      if (url.includes('/rest/api/2/issue/AK-123/comment')) {
        return new Response(JSON.stringify({ comments: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    await executeRunJob(
      harness.env,
      {
        tenantId: 'tenant_legacy',
        repoId: repo.repoId,
        taskId: task.taskId,
        runId: 'run_1',
        mode: 'full_run'
      },
      async () => {}
    );

    const firstRound = harness.getRun().reviewExecution;
    expect(firstRound).toMatchObject({ round: 1, status: 'completed' });
    expect(harness.getRun().reviewPostState).toMatchObject({ round: 1, status: 'completed', postedCount: 1 });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/api/2/issue/AK-123/comment') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: '401' }), { status: 200 });
      }
      if (url.includes('/rest/api/2/issue/AK-123/comment')) {
        return new Response(JSON.stringify({
          comments: []
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    await executeRunJob(
      harness.env,
      {
        tenantId: 'tenant_legacy',
        repoId: repo.repoId,
        taskId: task.taskId,
        runId: 'run_1',
        mode: 'review_only'
      },
      async () => {}
    );

    const secondRound = harness.getRun().reviewExecution;
    expect(secondRound).toMatchObject({ round: 2, status: 'completed', trigger: 'manual_rerun' });
    expect(secondRound?.enabled).toBe(true);
    expect(harness.getRun().reviewPostState).toMatchObject({
      provider: 'jira',
      round: 2,
      status: 'completed',
      postedCount: 1
    });
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Manual review started (round 2).'))).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Review completed (round 2;'))).toBe(true);
  });

  it('skips auto-review when effective setting is disabled', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      autoReview: {
        enabled: false,
        provider: 'jira',
        postInline: false
      }
    });
    const harness = createHarness(task, repo);
    sandboxState.current = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().reviewExecution).toMatchObject({
      enabled: false,
      trigger: 'auto_on_review',
      status: 'not_started',
      round: 0
    });
    expect(harness.getRun().reviewFindings).toBeUndefined();
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Auto-review skipped: disabled for this run context.'))).toBe(true);
  });

  it('preserves Codex resume/session parity through the adapterized execution path', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo();
    const harness = createHarness(task, repo);
    await harness.repoBoard.updateOperatorSession('run_1', {
      id: 'run_1:operator',
      runId: 'run_1',
      sandboxId: 'run_1',
      sessionName: 'operator',
      startedAt: '2026-03-02T00:00:00.000Z',
      actorId: 'same-session',
      actorLabel: 'Operator',
      connectionState: 'open',
      takeoverState: 'observing',
      llmAdapter: 'codex',
      llmSupportsResume: true
    });

    sandboxState.current = buildSandbox([
      { type: 'stdout', data: '{"thread_id":"thread-123"}\n' },
      { type: 'stdout', data: 'Use this to continue later: codex resume thread-123\n' },
      { type: 'stdout', data: 'Applied adapter regression coverage.\n' },
      { type: 'exit', exitCode: 0 }
    ]);

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun()).toMatchObject({
      status: 'DONE',
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread-123',
      llmResumeCommand: 'codex resume thread-123',
      latestCodexResumeCommand: 'codex resume thread-123',
      operatorSession: {
        llmAdapter: 'codex',
        llmSupportsResume: true,
        llmSessionId: 'thread-123',
        llmResumeCommand: 'codex resume thread-123',
        codexThreadId: 'thread-123',
        codexResumeCommand: 'codex resume thread-123'
      }
    });
    expect(harness.commands.some((command) => command.command.includes('codex exec'))).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'codex.resume_available')).toBe(true);
  });

  it('runs Cursor CLI through the same execution seam without fabricating resume support', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'cursor_cli',
        llmModel: 'cursor-default',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      llmAuthBundleR2Key: undefined
    });
    const harness = createHarness(task, repo);

    sandboxState.current = buildSandbox([
      { type: 'stdout', data: 'Cursor finished a non-interactive patch.\n' },
      { type: 'exit', exitCode: 0 }
    ]);

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun()).toMatchObject({
      status: 'DONE',
      llmAdapter: 'cursor_cli',
      llmSupportsResume: false,
      llmModel: 'cursor-default',
      llmReasoningEffort: 'medium'
    });
    expect(harness.getRun().llmResumeCommand).toBeUndefined();
    expect(harness.getRun().latestCodexResumeCommand).toBeUndefined();
    expect(sandboxState.current?.startProcessCommand).toContain('CURSOR_BIN');
    expect(harness.commands.some((command) => command.command.includes('CURSOR_BIN'))).toBe(true);
    expect(harness.logs.some((entry) => entry.message.includes('Cursor CLI was responsible for choosing and running validation commands.'))).toBe(true);
  });

  it('recovers push failures caused by remote branch rules with a single LLM remediation attempt', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo();
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let pushAttempts = 0;
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        return {
          success: true,
          exitCode: 0,
          stdout: '\n===CODEX_LAST_MESSAGE===\n{"branchName":"agent/push-fix-9k2m"}\n'
        };
      }
      if (command.includes('git push origin HEAD:')) {
        pushAttempts += 1;
        if (pushAttempts === 1) {
          return {
            success: false,
            exitCode: 1,
            stderr: "remote: GitLab: Branch name 'agent/task_repo_very_long/run_repo_very_long' does not follow the pattern '^.{1,63}$'\nTo https://example.com/org/repo.git\n! [remote rejected] HEAD -> agent/task_repo_very_long/run_repo_very_long (pre-receive hook declined)"
          };
        }
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun()).toMatchObject({
      status: 'DONE',
      branchName: 'agent/push-fix-9k2m'
    });
    expect(harness.commands.some((command) => command.command.includes('git push origin HEAD:agent/push-fix-9k2m'))).toBe(true);
    expect(harness.logs.some((entry) => entry.message.includes('Push remediation succeeded; adopting branch agent/push-fix-9k2m.'))).toBe(true);
  });

  it('fails when the remediation push attempt is also rejected', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo();
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        return {
          success: true,
          exitCode: 0,
          stdout: '\n===CODEX_LAST_MESSAGE===\n{"branchName":"agent/push-fix-still-bad"}\n'
        };
      }
      if (command.includes('git push origin HEAD:')) {
        return {
          success: false,
          exitCode: 1,
          stderr: "remote: GitLab: Branch name does not follow the pattern '^.{1,63}$'\n! [remote rejected] HEAD -> branch (pre-receive hook declined)"
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await expect(
      executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {})
    ).rejects.toThrow('Push remediation attempt failed.');

    expect(harness.getRun().status).toBe('FAILED');
  });

  it('does not run remediation for non-policy push failures', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo();
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let remediationPromptInvoked = false;
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        remediationPromptInvoked = true;
      }
      if (command.includes('git push origin HEAD:')) {
        return {
          success: false,
          exitCode: 1,
          stderr: 'fatal: Authentication failed for https://example.com/org/repo.git/'
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await expect(
      executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {})
    ).rejects.toThrow('Authentication failed');

    expect(remediationPromptInvoked).toBe(false);
  });

  it('does not allow branch rename remediation for existing review change requests', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo();
    const harness = createHarness(task, repo);
    await harness.repoBoard.transitionRun('run_1', {
      reviewUrl: 'https://github.com/abuiles/minions/pull/17',
      reviewNumber: 17,
      reviewProvider: 'github',
      changeRequest: {
        prompt: 'Please revise this change.',
        requestedAt: '2026-03-02T01:00:00.000Z'
      }
    });

    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let remediationPromptInvoked = false;
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        remediationPromptInvoked = true;
      }
      if (command.includes('git push origin HEAD:')) {
        return {
          success: false,
          exitCode: 1,
          stderr: "remote: GitLab: Branch name does not follow the pattern '^.{1,63}$'\n! [remote rejected] HEAD -> branch (pre-receive hook declined)"
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await expect(
      executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {})
    ).rejects.toThrow('Branch rename remediation is disabled for change requests');

    expect(remediationPromptInvoked).toBe(false);
  });

  it('applies repo commit message template when it already satisfies commit regex policy', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      commitConfig: {
        messageTemplate: 'feat(cp): {taskTitle} [{taskId}]',
        messageRegex: '^feat\\(cp\\): .+ \\[task_1\\]$'
      }
    });
    const harness = createHarness(task, repo);
    sandboxState.current = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.commands.some((command) => command.command.includes("git commit -m 'feat(cp): Adapter seam regression [task_1]'"))).toBe(true);
  });

  it('rewrites commit message through one LLM remediation attempt when repo regex policy rejects the candidate', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      commitConfig: {
        messageTemplate: 'AgentsKanban: {taskTitle}',
        messageRegex: '^feat\\(cp\\): .+$',
        messageExamples: ['feat(cp): Add banner block support']
      }
    });
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        return {
          success: true,
          exitCode: 0,
          stdout: '\n===CODEX_LAST_MESSAGE===\n{"commitMessage":"feat(cp): policy-compliant commit"}\n'
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.commands.some((command) => command.command.includes("git commit -m 'feat(cp): policy-compliant commit'"))).toBe(true);
  });

  it('uses LLM commit guidance even when no commit regex is configured', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo({
      commitConfig: {
        messageTemplate: 'Make sure commits follow the commit conventions used in this repository. Example: feat(JIRA-1234): Implement new feature.',
        messageExamples: ['feat(JIRA-1234): Implement new feature']
      }
    });
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      if (command.includes('/workspace/prompt-last-message.txt')) {
        return {
          success: true,
          exitCode: 0,
          stdout: '\n===CODEX_LAST_MESSAGE===\n{"commitMessage":"feat(JIRA-1234): Implement new feature"}\n'
        };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.commands.some((command) => command.command.includes("git commit -m 'feat(JIRA-1234): Implement new feature'"))).toBe(true);
  });

  it('creates deterministic checkpoint metadata and tracked context notes at dirty phase boundaries', async () => {
    const task = buildTask({
      taskPrompt: 'Implement deterministic checkpointing.',
      acceptanceCriteria: ['checkpoint commit exists', 'context note is tracked'],
      context: {
        notes: 'Persist checkpoint metadata and context notes.',
        links: [{ id: 'plan', label: 'P8 plan', url: 'https://example.com/p8' }]
      }
    });
    const repo = buildRepo({
      checkpointConfig: {
        enabled: true,
        triggerMode: 'phase_boundary',
        contextNotes: {
          enabled: true,
          filePath: '.agentskanban/context/run-context.md',
          cleanupBeforeReview: true
        },
        reviewPrep: {
          squashBeforeFirstReviewOpen: true,
          rewriteOnChangeRequestRerun: false
        }
      }
    });
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let statusCall = 0;
    sandbox.exec = async (command) => {
      if (command.includes('git status --short')) {
        statusCall += 1;
        if (statusCall === 2 || statusCall === 4) {
          return { success: true, exitCode: 0, stdout: 'M src/index.ts\n' };
        }
        return { success: true, exitCode: 0, stdout: '' };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().status).toBe('DONE');
    expect(harness.getRun().checkpoints).toHaveLength(1);
    expect(harness.getRun().checkpoints?.[0]).toMatchObject({
      checkpointId: 'run_1:cp:001:codex',
      phase: 'codex',
      commitMessage: 'agentskanban checkpoint 001 (codex) [run_1]',
      contextNotesPath: '.agentskanban/context/run-context.md'
    });
    expect(harness.events.some((event) => event.eventType === 'run.checkpoint.created')).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'run.review_prep.context_cleaned')).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'run.review_prep.squashed')).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Checkpoint created (codex):'))).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Review prep removed checkpoint context notes'))).toBe(true);
    expect(harness.getRun().timeline.some((entry) => entry.note?.includes('Review prep squashed 1 checkpoint commit'))).toBe(true);
    expect(harness.commands.some((command) => command.command.includes('git reset --soft'))).toBe(true);
    expect(harness.commands.filter((command) => command.command.includes('git add -A && git commit -m')).length).toBe(2);
    expect(sandbox.writes).toContainEqual({
      path: '/workspace/repo/.agentskanban/context/run-context.md',
      contents: [
        '# AgentsKanban Run Context',
        '',
        'runId: run_1',
        'taskId: task_1',
        'repoId: repo_1',
        'repoSlug: abuiles/minions',
        'branchName: agent/task_1/run_1',
        'checkpointSequence: 001',
        'checkpointPhase: codex',
        'contextNotesPath: .agentskanban/context/run-context.md',
        '',
        'Task:',
        '- title: Adapter seam regression',
        '- prompt: Implement deterministic checkpointing.',
        '',
        'Acceptance Criteria:',
        '- checkpoint commit exists',
        '- context note is tracked',
        '',
        'Notes:',
        '- Persist checkpoint metadata and context notes.',
        '',
        'Links:',
        '- P8 plan: https://example.com/p8',
        ''
      ].join('\n')
    });
  });

  it('does not create checkpoint commits when phase boundaries are clean', async () => {
    const task = buildTask();
    const repo = buildRepo({
      checkpointConfig: {
        enabled: true,
        triggerMode: 'phase_boundary',
        contextNotes: {
          enabled: true,
          filePath: '.agentskanban/context/run-context.md',
          cleanupBeforeReview: true
        },
        reviewPrep: {
          squashBeforeFirstReviewOpen: true,
          rewriteOnChangeRequestRerun: false
        }
      }
    });
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command) => {
      if (command.includes('git status --short')) {
        return { success: true, exitCode: 0, stdout: '' };
      }
      if (command.includes('git rev-parse HEAD')) {
        return { success: true, exitCode: 0, stdout: 'b'.repeat(40) };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().status).toBe('DONE');
    expect(harness.getRun().checkpoints).toBeUndefined();
    expect(harness.events.some((event) => event.eventType === 'run.checkpoint.created')).toBe(false);
    expect(sandbox.writes.some((entry) => entry.path.includes('.agentskanban/context/run-context.md'))).toBe(false);
    expect(harness.commands.some((command) => command.command.includes('agentskanban checkpoint'))).toBe(false);
  });

  it('treats already-committed checkpoint writes as idempotent when git commit reports nothing to commit', async () => {
    const task = buildTask();
    const repo = buildRepo({
      checkpointConfig: {
        enabled: true,
        triggerMode: 'phase_boundary',
        contextNotes: {
          enabled: true,
          filePath: '.agentskanban/context/run-context.md',
          cleanupBeforeReview: true
        },
        reviewPrep: {
          squashBeforeFirstReviewOpen: true,
          rewriteOnChangeRequestRerun: false
        }
      }
    });
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let statusCall = 0;
    sandbox.exec = async (command) => {
      if (command.includes('git status --short')) {
        statusCall += 1;
        if (statusCall === 2 || statusCall === 4) {
          return { success: true, exitCode: 0, stdout: 'M src/index.ts\n' };
        }
        return { success: true, exitCode: 0, stdout: '' };
      }
      if (command.includes("git add -A && git commit -m 'agentskanban checkpoint 001 (codex) [run_1]'")) {
        return {
          success: false,
          exitCode: 1,
          stdout: 'On branch agent/task_1/run_1\nnothing to commit, working tree clean\n'
        };
      }
      if (command.includes('git log -1 --pretty=%s')) {
        return { success: true, exitCode: 0, stdout: 'agentskanban checkpoint 001 (codex) [run_1]\n' };
      }
      if (command.includes('git rev-parse HEAD')) {
        return { success: true, exitCode: 0, stdout: 'c'.repeat(40) };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().status).toBe('DONE');
    expect(harness.getRun().checkpoints).toHaveLength(1);
    expect(harness.getRun().checkpoints?.[0]).toMatchObject({
      checkpointId: 'run_1:cp:001:codex',
      commitSha: 'c'.repeat(40)
    });
    expect(harness.events.some((event) => event.eventType === 'run.checkpoint.created')).toBe(true);
  });

  it('prepares first review push with context cleanup and checkpoint-history squash', async () => {
    const task = buildTask();
    const repo = buildRepo({
      checkpointConfig: {
        enabled: true,
        triggerMode: 'phase_boundary',
        contextNotes: {
          enabled: true,
          filePath: '.agentskanban/context/run-context.md',
          cleanupBeforeReview: true
        },
        reviewPrep: {
          squashBeforeFirstReviewOpen: true,
          rewriteOnChangeRequestRerun: false
        }
      }
    });
    const harness = createHarness(task, repo);
    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let statusCall = 0;
    sandbox.exec = async (command) => {
      if (command.includes('git status --short')) {
        statusCall += 1;
        if (statusCall === 2 || statusCall === 4) {
          return { success: true, exitCode: 0, stdout: 'M src/index.ts\n' };
        }
        return { success: true, exitCode: 0, stdout: '' };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().status).toBe('DONE');
    expect(harness.getRun().checkpoints).toHaveLength(1);
    expect(harness.commands.some((command) => command.command.includes('git ls-files --error-unmatch .agentskanban/context/run-context.md'))).toBe(true);
    expect(harness.commands.some((command) => command.command.includes('rm -f .agentskanban/context/run-context.md'))).toBe(true);
    expect(harness.commands.some((command) => command.command.includes('git merge-base HEAD origin/main'))).toBe(true);
    expect(harness.commands.some((command) => command.command.includes('git reset --soft'))).toBe(true);
    expect(harness.commands.some((command) => command.command.includes('git cat-file -e HEAD:.agentskanban/context/run-context.md'))).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'run.review_prep.context_cleaned')).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'run.review_prep.squashed')).toBe(true);
  });

  it('preserves no-rewrite behavior for change-request reruns on existing review branches', async () => {
    const task = buildTask();
    const repo = buildRepo({
      checkpointConfig: {
        enabled: true,
        triggerMode: 'phase_boundary',
        contextNotes: {
          enabled: true,
          filePath: '.agentskanban/context/run-context.md',
          cleanupBeforeReview: true
        },
        reviewPrep: {
          squashBeforeFirstReviewOpen: true,
          rewriteOnChangeRequestRerun: false
        }
      }
    });
    const harness = createHarness(task, repo);
    await harness.repoBoard.transitionRun('run_1', {
      reviewUrl: 'https://github.com/abuiles/minions/pull/17',
      reviewNumber: 17,
      reviewProvider: 'github',
      changeRequest: {
        prompt: 'Please revise this change.',
        requestedAt: '2026-03-02T01:00:00.000Z'
      }
    });

    const sandbox = buildSandbox([
      { type: 'stdout', data: 'Applied fix.\n' },
      { type: 'exit', exitCode: 0 }
    ]);
    const baseExec = sandbox.exec.bind(sandbox);
    let statusCall = 0;
    sandbox.exec = async (command) => {
      if (command.includes('git status --short')) {
        statusCall += 1;
        if (statusCall === 2) {
          return { success: true, exitCode: 0, stdout: 'M src/index.ts\n' };
        }
        return { success: true, exitCode: 0, stdout: '' };
      }
      return baseExec(command);
    };
    sandboxState.current = sandbox;

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

    expect(harness.getRun().status).toBe('DONE');
    expect(harness.commands.some((command) => command.command.includes('git reset --soft'))).toBe(false);
    expect(harness.commands.some((command) => command.command.includes('rm -f .agentskanban/context/run-context.md'))).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'run.review_prep.context_cleaned')).toBe(true);
    expect(harness.events.some((event) => event.eventType === 'run.review_prep.squashed')).toBe(false);
    expect(
      harness.getRun().timeline.some((entry) => entry.note?.includes('Review prep skipped checkpoint-history squash to preserve no-rewrite'))
    ).toBe(true);
  });

  it('emits partial usage entries when the run fails', async () => {
    const task = buildTask({
      uiMeta: {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }
    });
    const repo = buildRepo();
    const harness = createHarness(task, repo);

    sandboxState.current = buildSandbox([
      { type: 'stderr', data: 'Codex failed with a non-zero exit.\n' },
      { type: 'exit', exitCode: 1 }
    ]);

    await expect(
      executeRunJob(
        harness.env,
        { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' },
        async () => {}
      )
    ).rejects.toThrow();

    expect(usageLedgerWritesState.entries.length).toBeGreaterThan(0);
    for (const entry of usageLedgerWritesState.entries) {
      expect(entry.tenantId).toBeTruthy();
      expect(entry.source).toBeTruthy();
    }
    expect(usageLedgerWritesState.entries.some((entry) => entry.category === 'workflow_execution')).toBe(true);
    expect(usageLedgerWritesState.entries.some((entry) => entry.category === 'workflow_duration_ms')).toBe(true);
  });
});
