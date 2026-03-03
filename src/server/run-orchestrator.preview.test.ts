import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, Repo, Task } from '../ui/domain/types';
import { executeRunJob } from './run-orchestrator';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_1',
    slug: 'abuiles/minions-demo',
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath: 'abuiles/minions-demo',
    defaultBranch: 'main',
    baselineUrl: 'https://minions.example.com',
    enabled: true,
    previewAdapter: 'cloudflare_checks',
    evidenceMode: 'skip',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task_1',
    repoId: 'repo_1',
    title: 'Preview coverage',
    taskPrompt: 'Validate preview discovery.',
    acceptanceCriteria: ['preview works'],
    context: { links: [] },
    status: 'ACTIVE',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    repoId: 'repo_1',
    status: 'PR_OPEN',
    branchName: 'agent/run-1',
    headSha: 'a'.repeat(40),
    previewStatus: 'DISCOVERING',
    evidenceStatus: 'NOT_STARTED',
    errors: [],
    startedAt: '2026-03-02T00:00:00.000Z',
    simulationProfile: 'happy_path',
    timeline: [],
    pendingEvents: [],
    ...overrides
  };
}

function createHarness(repo: Repo, task = buildTask(), run = buildRun()) {
  const logs: Array<{ message: string; metadata?: Record<string, string | number | boolean> }> = [];
  const timelineNotes: string[] = [];
  let currentRun = { ...run };

  const repoBoard = {
    async getTask() {
      return { task };
    },
    async getRun() {
      return currentRun;
    },
    async appendRunLogs(_runId: string, entries: Array<{ message: string; metadata?: Record<string, string | number | boolean> }>) {
      logs.push(...entries);
    },
    async transitionRun(_runId: string, patch: Partial<AgentRun> & { appendTimelineNote?: string }) {
      const { appendTimelineNote, ...rest } = patch;
      currentRun = { ...currentRun, ...rest };
      if (appendTimelineNote) {
        timelineNotes.push(appendTimelineNote);
      }
    }
  };

  const board = {
    async getRepo() {
      return repo;
    },
    async getScmCredentialSecret(provider: string) {
      return provider === 'gitlab' ? 'glpat_test' : undefined;
    }
  };

  const env = {
    REPO_BOARD: { getByName: () => repoBoard },
    BOARD_INDEX: { getByName: () => board },
    GITHUB_TOKEN: 'ghp_test',
    GITLAB_TOKEN: 'glpat_test'
  } as unknown as Env;

  return { env, repoBoard, board, logs, timelineNotes, getRun: () => currentRun };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('executeRunJob preview flows', () => {
  it('discovers GitHub Cloudflare previews end-to-end through normalized SCM checks', async () => {
    const repo = buildRepo({
      previewConfig: { checkName: 'Workers Builds: minions-demo' }
    });
    const harness = createHarness(repo);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      check_runs: [
        {
          name: 'Workers Builds: minions-demo',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://dash.cloudflare.com/account/workers/services/view/minions-demo/builds/abc123',
          html_url: 'https://github.com/abuiles/minions-demo/actions/runs/1',
          output: {
            summary: 'Preview Alias URL: https://feature-minions.minions-demo.workers.dev'
          },
          app: { slug: 'cloudflare-workers-and-pages' }
        }
      ]
    }), { status: 200 })));

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: 'task_1', runId: 'run_1', mode: 'preview_only' }, async () => {});

    expect(harness.getRun()).toMatchObject({
      status: 'DONE',
      previewStatus: 'READY',
      previewUrl: 'https://feature-minions.minions-demo.workers.dev',
      evidenceStatus: 'NOT_STARTED'
    });
    expect(harness.timelineNotes).toContain('Preview discovered. Evidence execution is disabled for this repo.');
    expect(harness.logs.map((entry) => entry.message)).toContain(
      'Preview discovery matched Workers Builds: minions-demo via cloudflare from summary: https://feature-minions.minions-demo.workers.dev | checks: Workers Builds: minions-demo app=cloudflare-workers-and-pages source=github_check_run status=completed conclusion=success score=135 adapter=cloudflare preview=found | diagnostics: CLOUDFLARE_CHECK_MATCHED'
    );
  });

  it('discovers GitLab Cloudflare previews end-to-end through normalized SCM checks', async () => {
    const repo = buildRepo({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/minions-demo',
      slug: 'group/minions-demo',
      previewConfig: { checkName: 'workers-preview' }
    });
    const harness = createHarness(repo);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pipelines?')) {
        return new Response(JSON.stringify([
          {
            id: 9,
            name: 'pipeline',
            web_url: 'https://gitlab.example.com/group/minions-demo/-/pipelines/9',
            status: 'success',
            ref: 'feature/minions'
          }
        ]), { status: 200 });
      }
      if (url.includes('/statuses?')) {
        return new Response(JSON.stringify([
          {
            id: 21,
            name: 'workers-preview',
            target_url: 'https://feature-minions.minions-demo.workers.dev',
            description: 'Preview URL: https://feature-minions.minions-demo.workers.dev',
            status: 'running'
          }
        ]), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: 'task_1', runId: 'run_1', mode: 'preview_only' }, async () => {});

    expect(harness.getRun()).toMatchObject({
      status: 'DONE',
      previewStatus: 'READY',
      previewUrl: 'https://feature-minions.minions-demo.workers.dev',
      evidenceStatus: 'NOT_STARTED'
    });
    expect(harness.logs.map((entry) => entry.message)).toContain(
      'Preview discovery matched workers-preview via cloudflare from summary: https://feature-minions.minions-demo.workers.dev | checks: workers-preview source=gitlab_status status=in_progress score=105 adapter=cloudflare preview=found | diagnostics: CLOUDFLARE_CHECK_MATCHED'
    );
  });

  it('bypasses preview work entirely when previewMode is skip', async () => {
    const repo = buildRepo({ previewMode: 'skip' });
    const harness = createHarness(repo);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await executeRunJob(harness.env, { tenantId: 'tenant_legacy', repoId: repo.repoId, taskId: 'task_1', runId: 'run_1', mode: 'preview_only' }, async () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.getRun()).toMatchObject({
      status: 'DONE',
      previewStatus: 'UNKNOWN',
      evidenceStatus: 'NOT_STARTED'
    });
    expect(harness.timelineNotes).toContain('Preview discovery is disabled for this repo.');
  });
});
