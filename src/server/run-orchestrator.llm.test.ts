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
            'Codex OPENAI_API_KEY suffix: 1234'
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
      if (command.includes('git rev-parse HEAD')) {
        return { success: true, exitCode: 0, stdout: currentHead.value };
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
    SECRETS_KV: { get: vi.fn().mockResolvedValue('ghp_test_1234') },
    RUN_ARTIFACTS: {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode('bundle').buffer
      })
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

    await executeRunJob(harness.env, { repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

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

    await executeRunJob(harness.env, { repoId: repo.repoId, taskId: task.taskId, runId: 'run_1', mode: 'full_run' }, async () => {});

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
});
