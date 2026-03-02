import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, Repo, Task } from '../../ui/domain/types';
import { gitlabScmAdapter } from './gitlab';
import { getScmAdapter } from './registry';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_demo',
    slug: 'group/platform/demo',
    scmProvider: 'gitlab',
    scmBaseUrl: 'https://gitlab.example.com',
    projectPath: 'group/platform/demo',
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

describe('GitLabScmAdapter', () => {
  it('is returned by the SCM registry for GitLab repos', () => {
    expect(getScmAdapter(buildRepo())).toBe(gitlabScmAdapter);
  });

  it('normalizes GitLab source refs for hosted and self-managed subgroup URLs', () => {
    expect(gitlabScmAdapter.normalizeSourceRef(
      'https://gitlab.com/group/platform/demo/-/merge_requests/42',
      buildRepo({ scmBaseUrl: 'https://gitlab.com' })
    )).toEqual({
      kind: 'review_head',
      value: 'refs/merge-requests/42/head',
      label: 'MR !42',
      reviewNumber: 42,
      reviewProvider: 'gitlab'
    });

    expect(gitlabScmAdapter.normalizeSourceRef(
      'https://gitlab.example.com/group/platform/demo/-/tree/feature%2Fminions',
      buildRepo()
    )).toEqual({
      kind: 'branch',
      value: 'feature/minions',
      label: 'branch feature/minions'
    });

    expect(gitlabScmAdapter.normalizeSourceRef(
      'https://gitlab.example.com/group/platform/demo/-/commit/0123456789abcdef0123456789abcdef01234567',
      buildRepo()
    )).toEqual({
      kind: 'commit',
      value: '0123456789abcdef0123456789abcdef01234567',
      label: 'commit 0123456'
    });
  });

  it('builds authenticated clone URLs for arbitrary GitLab hosts', () => {
    expect(gitlabScmAdapter.buildCloneUrl(buildRepo(), { token: 'glpat-test/token' })).toBe(
      'https://oauth2:glpat-test%2Ftoken@gitlab.example.com/group/platform/demo.git'
    );
  });

  it('creates merge requests through the adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ iid: 123, web_url: 'https://gitlab.example.com/group/platform/demo/-/merge_requests/123' }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await gitlabScmAdapter.createReviewRequest(buildRepo(), buildTask(), buildRun(), { token: 'glpat_test' });

    expect(result).toEqual({
      provider: 'gitlab',
      number: 123,
      url: 'https://gitlab.example.com/group/platform/demo/-/merge_requests/123'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/group%2Fplatform%2Fdemo/merge_requests',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'glpat_test'
        })
      })
    );
  });

  it('upserts merge request notes through the adapter', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 7, body: '<!-- agentboard-run:run_demo -->' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await gitlabScmAdapter.upsertRunComment(
      buildRepo(),
      buildTask(),
      buildRun({
        reviewNumber: 123,
        previewUrl: 'https://preview.example.com',
        artifactManifest: {
          logs: { key: 'logs/run.log', label: 'Logs' },
          before: { key: 'before.png', label: 'Before', url: 'https://example.com/before.png' },
          metadata: { generatedAt: '2026-03-02T00:00:00.000Z', environmentId: 'env_demo' }
        }
      }),
      { token: 'glpat_test' }
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.example.com/api/v4/projects/group%2Fplatform%2Fdemo/merge_requests/123/notes/7',
      expect.objectContaining({
        method: 'PUT'
      })
    );
  });

  it('reads merge request state through the adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      iid: 42,
      web_url: 'https://gitlab.example.com/group/platform/demo/-/merge_requests/42',
      state: 'merged',
      merged_at: '2026-03-02T01:00:00.000Z',
      sha: 'a'.repeat(40),
      target_branch: 'main'
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gitlabScmAdapter.getReviewState(
      buildRepo(),
      buildRun({ reviewNumber: 42 }),
      { token: 'glpat_test' }
    )).resolves.toEqual({
      exists: true,
      state: 'merged',
      url: 'https://gitlab.example.com/group/platform/demo/-/merge_requests/42',
      number: 42,
      headSha: 'a'.repeat(40),
      baseBranch: 'main',
      mergedAt: '2026-03-02T01:00:00.000Z'
    });
  });

  it('normalizes GitLab pipelines and statuses into commit checks', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 9,
        name: 'pipeline',
        web_url: 'https://gitlab.example.com/group/platform/demo/-/pipelines/9',
        status: 'success',
        ref: 'main'
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 17,
        name: 'workers-preview',
        target_url: 'https://preview.pages.dev',
        description: 'Preview URL: https://preview.pages.dev',
        status: 'running'
      }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gitlabScmAdapter.listCommitChecks(buildRepo(), 'a'.repeat(40), { token: 'glpat_test' })).resolves.toEqual([
      {
        name: 'pipeline',
        detailsUrl: 'https://gitlab.example.com/group/platform/demo/-/pipelines/9',
        htmlUrl: 'https://gitlab.example.com/group/platform/demo/-/pipelines/9',
        summary: 'ref main',
        status: 'completed',
        conclusion: 'success',
        rawSource: 'gitlab_pipeline'
      },
      {
        name: 'workers-preview',
        detailsUrl: 'https://preview.pages.dev',
        htmlUrl: 'https://preview.pages.dev',
        summary: 'Preview URL: https://preview.pages.dev',
        status: 'in_progress',
        rawSource: 'gitlab_status'
      }
    ]);
  });

  it('checks default-branch reachability through the adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      compare_same_ref: false,
      commits: [{ id: '1' }]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gitlabScmAdapter.isCommitOnDefaultBranch(buildRepo(), 'a'.repeat(40), { token: 'glpat_test' })).resolves.toBe(true);
  });
});
