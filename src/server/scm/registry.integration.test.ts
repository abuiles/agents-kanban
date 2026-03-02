import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, Repo, Task } from '../../ui/domain/types';
import { getScmAdapter } from './registry';

function buildGithubRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_github_demo',
    slug: 'abuiles/minions',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'abuiles/minions',
    defaultBranch: 'main',
    baselineUrl: 'https://minions.example.com',
    enabled: true,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildGitlabRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_gitlab_demo',
    slug: 'group/platform/minions',
    scmProvider: 'gitlab',
    scmBaseUrl: 'https://gitlab.com',
    projectPath: 'group/platform/minions',
    defaultBranch: 'main',
    baselineUrl: 'https://minions.example.com',
    enabled: true,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task_demo',
    repoId: 'repo_demo',
    title: 'SCM adapter integration',
    taskPrompt: 'Validate the provider-neutral adapter path.',
    acceptanceCriteria: ['adapter path works'],
    context: { links: [] },
    status: 'ACTIVE',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run_demo',
    taskId: 'task_demo',
    repoId: 'repo_demo',
    status: 'PR_OPEN',
    branchName: 'agent/run-demo',
    previewStatus: 'UNKNOWN',
    evidenceStatus: 'NOT_STARTED',
    errors: [],
    startedAt: '2026-03-02T00:00:00.000Z',
    simulationProfile: 'happy_path',
    timeline: [],
    pendingEvents: [],
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SCM adapter registry integration', () => {
  it('keeps GitHub regression behavior intact through the provider-neutral adapter layer', async () => {
    const repo = buildGithubRepo();
    const adapter = getScmAdapter(repo);

    expect(adapter.normalizeSourceRef('https://github.com/abuiles/minions/pull/42', repo)).toEqual({
      kind: 'review_head',
      value: 'pull/42/head',
      label: 'PR #42',
      reviewNumber: 42,
      reviewProvider: 'github'
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42,
        html_url: 'https://github.com/abuiles/minions/pull/42'
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42,
        html_url: 'https://github.com/abuiles/minions/pull/42',
        state: 'closed',
        merged_at: '2026-03-02T01:00:00.000Z',
        head: { sha: 'a'.repeat(40) },
        base: { ref: 'main' }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'identical' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.createReviewRequest(repo, buildTask(), buildRun(), { token: 'ghp_test' })).resolves.toEqual({
      provider: 'github',
      number: 42,
      url: 'https://github.com/abuiles/minions/pull/42'
    });

    await expect(adapter.getReviewState(repo, buildRun({ reviewNumber: 42 }), { token: 'ghp_test' })).resolves.toEqual({
      exists: true,
      state: 'merged',
      url: 'https://github.com/abuiles/minions/pull/42',
      number: 42,
      headSha: 'a'.repeat(40),
      baseBranch: 'main',
      mergedAt: '2026-03-02T01:00:00.000Z'
    });

    await expect(adapter.isCommitOnDefaultBranch(repo, 'a'.repeat(40), { token: 'ghp_test' })).resolves.toBe(true);
  });

  it('supports hosted GitLab MR source refs and MR creation through the provider-neutral adapter layer', async () => {
    const repo = buildGitlabRepo({
      scmBaseUrl: 'https://gitlab.com'
    });
    const adapter = getScmAdapter(repo);

    expect(adapter.normalizeSourceRef('https://gitlab.com/group/platform/minions/-/merge_requests/77', repo)).toEqual({
      kind: 'review_head',
      value: 'refs/merge-requests/77/head',
      label: 'MR !77',
      reviewNumber: 77,
      reviewProvider: 'gitlab'
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 77,
        web_url: 'https://gitlab.com/group/platform/minions/-/merge_requests/77'
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 77,
        web_url: 'https://gitlab.com/group/platform/minions/-/merge_requests/77',
        state: 'opened',
        sha: 'b'.repeat(40),
        target_branch: 'main'
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.createReviewRequest(repo, buildTask(), buildRun(), { token: 'glpat_test' })).resolves.toEqual({
      provider: 'gitlab',
      number: 77,
      url: 'https://gitlab.com/group/platform/minions/-/merge_requests/77'
    });

    await expect(adapter.getReviewState(repo, buildRun({ reviewNumber: 77 }), { token: 'glpat_test' })).resolves.toEqual({
      exists: true,
      state: 'open',
      url: 'https://gitlab.com/group/platform/minions/-/merge_requests/77',
      number: 77,
      headSha: 'b'.repeat(40),
      baseBranch: 'main',
      mergedAt: undefined
    });
  });

  it('supports self-managed GitLab subgroup source refs and merge readiness checks through the provider-neutral adapter layer', async () => {
    const repo = buildGitlabRepo({
      slug: 'group/subgroup/minions',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/subgroup/minions'
    });
    const adapter = getScmAdapter(repo);

    expect(adapter.normalizeSourceRef('https://gitlab.example.com/group/subgroup/minions/-/tree/feature%2Fadapter', repo)).toEqual({
      kind: 'branch',
      value: 'feature/adapter',
      label: 'branch feature/adapter'
    });
    expect(adapter.normalizeSourceRef(
      'https://gitlab.example.com/group/subgroup/minions/-/commit/0123456789abcdef0123456789abcdef01234567',
      repo
    )).toEqual({
      kind: 'commit',
      value: '0123456789abcdef0123456789abcdef01234567',
      label: 'commit 0123456'
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 88,
        web_url: 'https://gitlab.example.com/group/subgroup/minions/-/merge_requests/88'
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        compare_same_ref: false,
        commits: [{ id: '1' }]
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.createReviewRequest(repo, buildTask(), buildRun(), { token: 'glpat_self_managed' })).resolves.toEqual({
      provider: 'gitlab',
      number: 88,
      url: 'https://gitlab.example.com/group/subgroup/minions/-/merge_requests/88'
    });

    await expect(adapter.isCommitOnDefaultBranch(repo, 'c'.repeat(40), { token: 'glpat_self_managed' })).resolves.toBe(true);
  });
});
