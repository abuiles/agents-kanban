import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenantAuthDbMocks = vi.hoisted(() => ({
  resolveSessionByToken: vi.fn(),
  hasActiveTenantAccess: vi.fn(),
  getTenantMembership: vi.fn(),
  resolveApiToken: vi.fn(),
  listUserMemberships: vi.fn()
}));

const sandboxMocks = vi.hoisted(() => ({
  getSandbox: vi.fn()
}));

vi.mock('./tenant-auth-db', () => tenantAuthDbMocks);
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: sandboxMocks.getSandbox
}));

import { handleGetRunTerminal, handleGetRunWs, handleTakeoverRun } from './router';

function createEnv(overrides: {
  repoBoard?: Record<string, unknown>;
  board?: Record<string, unknown>;
} = {}): Env {
  const repoBoardBase = {
    getTerminalBootstrap: vi.fn(async (_runId: string, _tenantId?: string, sandboxRole: 'main' | 'review' = 'main') => ({
      runId: 'run_repo_1_demo',
      repoId: 'repo_1',
      taskId: 'task_1',
      sandboxRole,
      requestedSandboxId: sandboxRole === 'review' ? 'run_repo_1_demo:review' : 'run_repo_1_demo',
      resolvedSandboxId: sandboxRole === 'review' ? 'run_repo_1_demo:review' : 'run_repo_1_demo',
      sandboxId: sandboxRole === 'review' ? 'run_repo_1_demo:review' : 'run_repo_1_demo',
      sessionName: sandboxRole === 'review' ? 'operator-run_repo_1_demo-review' : 'operator-run_repo_1_demo',
      status: 'PR_OPEN',
      attachable: true,
      wsPath: sandboxRole === 'review'
        ? '/api/runs/run_repo_1_demo/ws?sandboxRole=review'
        : '/api/runs/run_repo_1_demo/ws',
      cols: 120,
      rows: 32
    })),
    getRun: vi.fn(async () => ({
      runId: 'run_repo_1_demo',
      repoId: 'repo_1',
      taskId: 'task_1',
      sandboxId: 'run_repo_1_demo',
      reviewSandboxId: 'run_repo_1_demo:review',
      codexProcessId: 'proc_1',
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread-1',
      llmResumeCommand: 'codex resume thread-1',
      latestCodexResumeCommand: 'codex resume thread-1',
      status: 'PR_OPEN'
    })),
    updateOperatorSession: vi.fn(async () => undefined),
    takeOverRun: vi.fn(async () => ({ runId: 'run_repo_1_demo', status: 'OPERATOR_CONTROLLED' }))
  };

  const boardBase = {
    findRunRepoId: vi.fn(async () => 'repo_1'),
    getRepo: vi.fn(async () => ({
      repoId: 'repo_1',
      tenantId: 'tenant_local'
    }))
  };
  const repoBoard = { ...repoBoardBase, ...(overrides.repoBoard ?? {}) };
  const board = { ...boardBase, ...(overrides.board ?? {}) };

  return {
    BOARD_INDEX: {
      getByName: vi.fn(() => board)
    },
    REPO_BOARD: {
      getByName: vi.fn(() => repoBoard)
    },
    Sandbox: {}
  } as unknown as Env;
}

describe('router sandbox role operator controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantAuthDbMocks.resolveSessionByToken.mockResolvedValue({
      user: { id: 'user_1' },
      session: { id: 'sess_1', activeTenantId: 'tenant_local' }
    });
    tenantAuthDbMocks.hasActiveTenantAccess.mockResolvedValue(true);
  });

  it('defaults terminal bootstrap to main sandbox role', async () => {
    const env = createEnv();
    const response = await handleGetRunTerminal(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/terminal', {
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    const repoBoard = env.REPO_BOARD.getByName('repo_1') as unknown as { getTerminalBootstrap: ReturnType<typeof vi.fn> };
    expect(repoBoard.getTerminalBootstrap).toHaveBeenCalledWith('run_repo_1_demo', 'tenant_local', 'main');
  });

  it('accepts explicit review sandbox role for terminal bootstrap', async () => {
    const env = createEnv();
    const response = await handleGetRunTerminal(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/terminal?sandboxRole=review', {
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    const repoBoard = env.REPO_BOARD.getByName('repo_1') as unknown as { getTerminalBootstrap: ReturnType<typeof vi.fn> };
    expect(repoBoard.getTerminalBootstrap).toHaveBeenCalledWith('run_repo_1_demo', 'tenant_local', 'review');
  });

  it('rejects invalid sandbox role query values', async () => {
    const env = createEnv();
    const response = await handleGetRunTerminal(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/terminal?sandboxRole=preview', {
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );
    expect(response.status).toBe(400);
  });

  it('boots websocket sessions on the review sandbox when requested', async () => {
    const env = createEnv();
    const terminal = vi.fn(async () => new Response('ok', { status: 200 }));
    sandboxMocks.getSandbox.mockReturnValue({
      createSession: vi.fn(async () => undefined),
      getSession: vi.fn(async () => ({ terminal }))
    });

    const response = await handleGetRunWs(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/ws?sandboxRole=review', {
        headers: {
          'x-session-token': 'session-token',
          Upgrade: 'websocket'
        }
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    const repoBoard = env.REPO_BOARD.getByName('repo_1') as unknown as {
      updateOperatorSession: ReturnType<typeof vi.fn>;
    };
    expect(repoBoard.updateOperatorSession).toHaveBeenCalledWith(
      'run_repo_1_demo',
      expect.objectContaining({
        sandboxRole: 'review',
        sandboxId: 'run_repo_1_demo:review'
      }),
      'tenant_local'
    );
  });

  it('keeps takeover backward-compatible with empty payload (main sandbox default)', async () => {
    const env = createEnv();
    const killProcess = vi.fn(async () => undefined);
    const getProcess = vi.fn(async () => ({ status: 'stopped' }));
    sandboxMocks.getSandbox.mockReturnValue({
      killProcess,
      getProcess
    });

    const response = await handleTakeoverRun(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/takeover', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token' }
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    expect(sandboxMocks.getSandbox).toHaveBeenCalledWith((env as unknown as { Sandbox: unknown }).Sandbox, 'run_repo_1_demo');
    const repoBoard = env.REPO_BOARD.getByName('repo_1') as unknown as { takeOverRun: ReturnType<typeof vi.fn> };
    expect(repoBoard.takeOverRun).toHaveBeenCalledWith(
      'run_repo_1_demo',
      { actorId: 'same-session', actorLabel: 'Operator' },
      'tenant_local',
      'main'
    );
  });

  it('supports explicit review-sandbox takeover targeting', async () => {
    const env = createEnv();
    const killProcess = vi.fn(async () => undefined);
    const getProcess = vi.fn(async () => ({ status: 'stopped' }));
    sandboxMocks.getSandbox.mockReturnValue({
      killProcess,
      getProcess
    });

    const response = await handleTakeoverRun(
      new Request('https://minions.example.test/api/runs/run_repo_1_demo/takeover', {
        method: 'POST',
        headers: { 'x-session-token': 'session-token', 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxRole: 'review' })
      }),
      env,
      { runId: 'run_repo_1_demo' }
    );

    expect(response.status).toBe(200);
    expect(sandboxMocks.getSandbox).toHaveBeenCalledWith((env as unknown as { Sandbox: unknown }).Sandbox, 'run_repo_1_demo:review');
    const repoBoard = env.REPO_BOARD.getByName('repo_1') as unknown as { takeOverRun: ReturnType<typeof vi.fn> };
    expect(repoBoard.takeOverRun).toHaveBeenCalledWith(
      'run_repo_1_demo',
      { actorId: 'same-session', actorLabel: 'Operator' },
      'tenant_local',
      'review'
    );
  });
});
