import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, Repo, Task } from '../../ui/domain/types';
import { githubScmAdapter } from './github';
import { getScmAdapter } from './registry';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_demo',
    slug: 'acme/demo',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'acme/demo',
    defaultBranch: 'main',
    baselineUrl: 'https://example.com',
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
    title: 'Update demo flow',
    taskPrompt: 'Do the thing',
    acceptanceCriteria: ['it works'],
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

describe('GitHubScmAdapter', () => {
  it('is returned by the SCM registry for GitHub repos', () => {
    expect(getScmAdapter(buildRepo())).toBe(githubScmAdapter);
  });

  it('keeps GitHub source-ref normalization behavior compatible', () => {
    expect(githubScmAdapter.normalizeSourceRef('https://github.com/acme/demo/pull/42', buildRepo())).toEqual({
      kind: 'review_head',
      value: 'pull/42/head',
      label: 'PR #42',
      reviewNumber: 42,
      reviewProvider: 'github'
    });
    expect(githubScmAdapter.normalizeSourceRef('https://github.com/acme/demo/tree/feature/minions', buildRepo())).toEqual({
      kind: 'branch',
      value: 'feature/minions',
      label: 'branch feature/minions'
    });
    expect(() => githubScmAdapter.normalizeSourceRef('https://github.com/other/repo/pull/1', buildRepo())).toThrow(
      'Task source ref points to other/repo, expected acme/demo.'
    );
  });

  it('creates pull requests through the adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ number: 123, html_url: 'https://github.com/acme/demo/pull/123' }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await githubScmAdapter.createReviewRequest(buildRepo(), buildTask(), buildRun(), { token: 'ghp_test' });

    expect(result).toEqual({ provider: 'github', number: 123, url: 'https://github.com/acme/demo/pull/123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/demo/pulls',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_test'
        })
      })
    );
  });

  it('upserts the run comment through the adapter', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 7, body: '<!-- agentboard-run:run_demo -->' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await githubScmAdapter.upsertRunComment(
      buildRepo(),
      buildTask(),
      buildRun({
        prNumber: 123,
        previewUrl: 'https://preview.example.com',
        artifactManifest: {
          logs: { key: 'logs/run.log', label: 'Logs' },
          before: { key: 'before.png', label: 'Before', url: 'https://example.com/before.png' },
          metadata: { generatedAt: '2026-03-02T00:00:00.000Z', environmentId: 'env_demo' }
        }
      }),
      { token: 'ghp_test' }
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/acme/demo/issues/comments/7',
      expect.objectContaining({
        method: 'PATCH'
      })
    );
  });

  it('normalizes GitHub check runs through the adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        check_runs: [{
          name: 'Workers Builds: demo',
          details_url: 'https://dash.cloudflare.com/demo',
          html_url: 'https://github.com/acme/demo/runs/1',
          status: 'completed',
          conclusion: 'success',
          output: { summary: 'Preview Alias URL: https://demo.workers.dev' },
          app: { slug: 'cloudflare-workers-and-pages' }
        }]
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(githubScmAdapter.listCommitChecks(buildRepo(), 'a'.repeat(40), { token: 'ghp_test' })).resolves.toEqual([{
      name: 'Workers Builds: demo',
      detailsUrl: 'https://dash.cloudflare.com/demo',
      htmlUrl: 'https://github.com/acme/demo/runs/1',
      status: 'completed',
      conclusion: 'success',
      summary: 'Preview Alias URL: https://demo.workers.dev',
      appSlug: 'cloudflare-workers-and-pages',
      rawSource: 'github_check_run'
    }]);
  });

  it('checks default-branch reachability through the adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'behind' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(githubScmAdapter.isCommitOnDefaultBranch(buildRepo(), 'a'.repeat(40), { token: 'ghp_test' })).resolves.toBe(true);
  });
});
