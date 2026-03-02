import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import type { AgentRun, BoardSnapshotV1, Repo, Task, TaskDetail, TerminalBootstrap } from '../../src/ui/domain/types';

type JsonValue = Record<string, unknown>;

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as ExecutionContext;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiResponse(path, init);
  if (!response.ok) {
    throw new Error(`API ${init?.method ?? 'GET'} ${path} failed with status ${response.status}.`);
  }
  return await response.json() as T;
}

async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`https://minions.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  return worker.fetch(request, env, createExecutionContext());
}

function taskInput(repoId: string, title: string, patch: Partial<JsonValue> = {}) {
  return {
    repoId,
    title,
    taskPrompt: `${title} prompt`,
    acceptanceCriteria: [`${title} done`],
    context: { links: [] },
    status: 'READY',
    ...patch
  };
}

describe('Stage 3.5 LLM adapter dogfood API coverage', () => {
  it('keeps Codex session persistence and resumable takeover visible through the API surfaces', async () => {
    const repo = await api<Repo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'abuiles/minions-codex-dogfood',
        baselineUrl: 'https://codex-dogfood.example.com',
        defaultBranch: 'main'
      })
    });
    const task = await api<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskInput(repo.repoId, 'Codex adapter truthfulness', {
        llmAdapter: 'codex',
        llmModel: 'gpt-5.3-codex',
        llmReasoningEffort: 'medium'
      }))
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.transitionRun(run.runId, {
      status: 'RUNNING_CODEX',
      sandboxId: run.runId,
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmModel: 'gpt-5.3-codex',
      llmReasoningEffort: 'medium',
      llmSessionId: 'thread-123',
      llmResumeCommand: 'codex resume thread-123',
      latestCodexResumeCommand: 'codex resume thread-123'
    });
    await repoBoard.updateOperatorSession(run.runId, {
      id: `${run.runId}:operator`,
      runId: run.runId,
      sandboxId: run.runId,
      sessionName: 'operator',
      startedAt: '2026-03-02T00:00:00.000Z',
      actorId: 'same-session',
      actorLabel: 'Operator',
      connectionState: 'open',
      takeoverState: 'observing',
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread-123',
      llmResumeCommand: 'codex resume thread-123',
      codexThreadId: 'thread-123',
      codexResumeCommand: 'codex resume thread-123'
    });

    const detail = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(task.taskId)}`);
    const terminal = await api<TerminalBootstrap>(`/api/runs/${encodeURIComponent(run.runId)}/terminal`);
    const takenOver = await api<AgentRun>(`/api/runs/${encodeURIComponent(run.runId)}/takeover`, { method: 'POST' });
    const exported = await api<BoardSnapshotV1>('/api/debug/export');

    expect(detail.latestRun).toMatchObject({
      runId: run.runId,
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread-123',
      llmResumeCommand: 'codex resume thread-123',
      latestCodexResumeCommand: 'codex resume thread-123'
    });
    expect(terminal).toMatchObject({
      runId: run.runId,
      attachable: true,
      llmSupportsResume: true,
      llmResumeCommand: 'codex resume thread-123',
      codexResumeCommand: 'codex resume thread-123'
    });
    expect(takenOver.operatorSession).toMatchObject({
      takeoverState: 'resumable',
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmResumeCommand: 'codex resume thread-123'
    });
    expect(exported.runs.find((candidate) => candidate.runId === run.runId)).toMatchObject({
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread-123',
      llmResumeCommand: 'codex resume thread-123',
      latestCodexResumeCommand: 'codex resume thread-123',
      operatorSession: {
        takeoverState: 'resumable',
        llmResumeCommand: 'codex resume thread-123'
      }
    });

    await api('/api/debug/import', {
      method: 'POST',
      body: JSON.stringify(exported)
    });

    const reloadedDetail = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(task.taskId)}`);
    expect(reloadedDetail.latestRun).toMatchObject({
      llmAdapter: 'codex',
      llmSupportsResume: true,
      llmSessionId: 'thread-123',
      llmResumeCommand: 'codex resume thread-123',
      operatorSession: {
        takeoverState: 'resumable',
        llmResumeCommand: 'codex resume thread-123'
      }
    });
  });

  it('surfaces Cursor CLI execution and non-resumable takeover truthfully through task/run APIs', async () => {
    const repo = await api<Repo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'abuiles/minions-cursor-dogfood',
        baselineUrl: 'https://cursor-dogfood.example.com',
        defaultBranch: 'main'
      })
    });
    const task = await api<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskInput(repo.repoId, 'Cursor CLI adapter truthfulness', {
        llmAdapter: 'cursor_cli',
        llmModel: 'cursor-default',
        llmReasoningEffort: 'medium'
      }))
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.transitionRun(run.runId, {
      status: 'RUNNING_CODEX',
      sandboxId: run.runId,
      llmAdapter: 'cursor_cli',
      llmSupportsResume: false,
      llmModel: 'cursor-default',
      llmReasoningEffort: 'medium'
    });
    await repoBoard.updateOperatorSession(run.runId, {
      id: `${run.runId}:operator`,
      runId: run.runId,
      sandboxId: run.runId,
      sessionName: 'operator',
      startedAt: '2026-03-02T00:00:00.000Z',
      actorId: 'same-session',
      actorLabel: 'Operator',
      connectionState: 'open',
      takeoverState: 'observing',
      llmAdapter: 'cursor_cli',
      llmSupportsResume: false
    });

    const detail = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(task.taskId)}`);
    const terminal = await api<TerminalBootstrap>(`/api/runs/${encodeURIComponent(run.runId)}/terminal`);
    const takenOver = await api<AgentRun>(`/api/runs/${encodeURIComponent(run.runId)}/takeover`, { method: 'POST' });

    expect(detail.latestRun).toMatchObject({
      runId: run.runId,
      llmAdapter: 'cursor_cli',
      llmSupportsResume: false,
      llmModel: 'cursor-default',
      llmReasoningEffort: 'medium'
    });
    expect(detail.latestRun?.llmResumeCommand).toBeUndefined();
    expect(terminal).toMatchObject({
      runId: run.runId,
      attachable: true,
      llmSupportsResume: false
    });
    expect(terminal.llmResumeCommand).toBeUndefined();
    expect(takenOver.operatorSession).toMatchObject({
      takeoverState: 'operator_control',
      llmAdapter: 'cursor_cli',
      llmSupportsResume: false
    });
    expect(takenOver.operatorSession?.llmResumeCommand).toBeUndefined();
  });

  it('rejects cross-tenant terminal and artifact reads', async () => {
    const repo = await api<Repo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 'tenant_acme',
        slug: 'acme/minions-tenant-checks',
        baselineUrl: 'https://tenant-checks.example.com',
        defaultBranch: 'main'
      })
    });
    const task = await api<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskInput(repo.repoId, 'Tenant access checks'))
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.transitionRun(run.runId, {
      status: 'RUNNING_CODEX',
      sandboxId: run.runId
    });
    await repoBoard.storeArtifactManifest(run.runId);

    const terminalResponse = await apiResponse(`/api/runs/${encodeURIComponent(run.runId)}/terminal`, {
      headers: { 'X-Tenant-Id': 'tenant_other' }
    });
    const artifactResponse = await apiResponse(`/api/runs/${encodeURIComponent(run.runId)}/artifacts`, {
      headers: { 'X-Tenant-Id': 'tenant_other' }
    });

    expect(terminalResponse.status).toBe(404);
    expect(artifactResponse.status).toBe(404);
  });
});
