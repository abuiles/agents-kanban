import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { getScmAdapter } from '../../src/server/scm/registry';
import type { Repo, ScmCredential, Task, TaskDetail } from '../../src/ui/domain/types';

type JsonValue = Record<string, unknown>;

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as ExecutionContext;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const request = new Request(`https://minions.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  const response = await worker.fetch(request, env, createExecutionContext());
  if (!response.ok) {
    throw new Error(`API ${init?.method ?? 'GET'} ${path} failed with status ${response.status}.`);
  }
  return await response.json() as T;
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

describe('Stage 3.5 SCM dogfood API coverage', () => {
  it('dogfoods the GitHub repo/task/run APIs without regressing adapterized GitHub review behavior', async () => {
    const repo = await api<Repo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'abuiles/minions-github-dogfood',
        baselineUrl: 'https://github-dogfood.example.com',
        defaultBranch: 'main'
      })
    });

    const task = await api<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskInput(repo.repoId, 'GitHub dogfood regression', {
        sourceRef: 'https://github.com/abuiles/minions-github-dogfood/pull/42'
      }))
    });
    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const run = await repoBoard.startRun(task.taskId);
    await repoBoard.transitionRun(run.runId, {
      status: 'PR_OPEN',
      reviewUrl: 'https://github.com/abuiles/minions-github-dogfood/pull/42',
      reviewNumber: 42,
      reviewProvider: 'github',
      reviewState: 'open',
      headSha: 'a'.repeat(40)
    });

    const detail = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(task.taskId)}`);
    const snapshot = await api<{ repos: Repo[]; tasks: Task[]; runs: Array<{ runId: string; reviewProvider?: string; prNumber?: number }> }>(
      `/api/board?repoId=${encodeURIComponent(repo.repoId)}`
    );

    expect(detail.repo).toMatchObject({
      repoId: repo.repoId,
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com',
      projectPath: 'abuiles/minions-github-dogfood'
    });
    expect(detail.latestRun).toMatchObject({
      runId: run.runId,
      reviewProvider: 'github',
      reviewNumber: 42,
      prNumber: 42
    });
    expect(getScmAdapter(detail.repo).normalizeSourceRef(detail.task.sourceRef!, detail.repo)).toEqual({
      kind: 'review_head',
      value: 'pull/42/head',
      label: 'PR #42',
      reviewNumber: 42,
      reviewProvider: 'github'
    });
    expect(snapshot.repos.map((candidate) => candidate.repoId)).toContain(repo.repoId);
    expect(snapshot.tasks.map((candidate) => candidate.taskId)).toContain(task.taskId);
    expect(snapshot.runs.find((candidate) => candidate.runId === run.runId)).toMatchObject({
      reviewProvider: 'github',
      prNumber: 42
    });
  });

  it('dogfoods hosted and self-managed GitLab configuration through the repo/task APIs', async () => {
    const hostedRepo = await api<Repo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'group/platform/minions-hosted',
        projectPath: 'group/platform/minions-hosted',
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.com',
        baselineUrl: 'https://hosted-gitlab.example.com',
        defaultBranch: 'main'
      })
    });
    const selfManagedRepo = await api<Repo>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'group/subgroup/minions-self-managed',
        projectPath: 'group/subgroup/minions-self-managed',
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.example.com',
        baselineUrl: 'https://self-managed-gitlab.example.com',
        defaultBranch: 'main'
      })
    });
    const credential = await api<ScmCredential>('/api/scm/credentials', {
      method: 'POST',
      body: JSON.stringify({
        scmProvider: 'gitlab',
        host: 'GitLab.EXAMPLE.com',
        label: 'Self-managed GitLab',
        token: 'glpat_secret'
      })
    });

    const hostedTask = await api<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskInput(hostedRepo.repoId, 'Hosted GitLab MR', {
        sourceRef: 'https://gitlab.com/group/platform/minions-hosted/-/merge_requests/77'
      }))
    });
    const selfManagedTask = await api<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(taskInput(selfManagedRepo.repoId, 'Self-managed GitLab branch', {
        sourceRef: 'https://gitlab.example.com/group/subgroup/minions-self-managed/-/tree/feature%2Fadapter'
      }))
    });

    const hostedRun = await env.REPO_BOARD.getByName(hostedRepo.repoId).startRun(hostedTask.taskId);
    await env.REPO_BOARD.getByName(hostedRepo.repoId).transitionRun(hostedRun.runId, {
      status: 'PR_OPEN',
      reviewUrl: 'https://gitlab.com/group/platform/minions-hosted/-/merge_requests/77',
      reviewNumber: 77,
      reviewProvider: 'gitlab',
      reviewState: 'open',
      headSha: 'b'.repeat(40)
    });

    const hostedDetail = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(hostedTask.taskId)}`);
    const selfManagedDetail = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(selfManagedTask.taskId)}`);

    expect(hostedDetail.repo).toMatchObject({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.com',
      projectPath: 'group/platform/minions-hosted'
    });
    expect(selfManagedDetail.repo).toMatchObject({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/subgroup/minions-self-managed'
    });
    expect(credential).toMatchObject({
      credentialId: 'gitlab:gitlab.example.com',
      scmProvider: 'gitlab',
      host: 'gitlab.example.com',
      hasSecret: true
    });
    expect(hostedDetail.latestRun).toMatchObject({
      reviewProvider: 'gitlab',
      reviewNumber: 77,
      prNumber: 77
    });
    expect(getScmAdapter(hostedDetail.repo).normalizeSourceRef(hostedDetail.task.sourceRef!, hostedDetail.repo)).toEqual({
      kind: 'review_head',
      value: 'refs/merge-requests/77/head',
      label: 'MR !77',
      reviewNumber: 77,
      reviewProvider: 'gitlab'
    });
    expect(getScmAdapter(selfManagedDetail.repo).normalizeSourceRef(selfManagedDetail.task.sourceRef!, selfManagedDetail.repo)).toEqual({
      kind: 'branch',
      value: 'feature/adapter',
      label: 'branch feature/adapter'
    });
  });
});
