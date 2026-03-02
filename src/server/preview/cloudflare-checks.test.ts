import { describe, expect, it } from 'vitest';
import { cloudflareChecksPreviewAdapter, inspectCloudflarePreviewDiscovery } from './cloudflare-checks';
import type { Repo } from '../../ui/domain/types';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_1',
    slug: 'abuiles/minions-demo',
    defaultBranch: 'main',
    baselineUrl: 'https://example.com',
    enabled: true,
    previewProvider: 'cloudflare',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

describe('cloudflareChecksPreviewAdapter', () => {
  it('extracts the Cloudflare preview alias URL from GitHub check summaries', async () => {
    const result = await cloudflareChecksPreviewAdapter.resolve({
      repo: buildRepo(),
      checks: [
        {
          name: 'Workers Builds: minions-demo',
          appSlug: 'cloudflare-workers-and-pages',
          detailsUrl: 'https://dash.cloudflare.com/account/workers/services/view/minions-demo/builds/abc123',
          htmlUrl: 'https://github.com/abuiles/minions-demo/runs/123',
          summary: `
Build ID: [abc123](https://dash.cloudflare.com/account/workers/services/view/minions-demo/builds/abc123)
Preview URL: https://b537c13e-minions-demo.abuiles.workers.dev
Preview Alias URL: https://abuiles-patch-1-minions-demo.abuiles.workers.dev
`,
          rawSource: 'github_check_run'
        }
      ]
    });

    expect(result.resolution.status).toBe('ready');
    expect(result.resolution.previewUrl).toBe('https://abuiles-patch-1-minions-demo.abuiles.workers.dev');
    expect(result.resolution.diagnostics).toEqual([
      {
        code: 'CLOUDFLARE_CHECK_MATCHED',
        level: 'info',
        message: 'Discovered preview URL from Workers Builds: minions-demo.',
        metadata: {
          name: 'Workers Builds: minions-demo',
          appSlug: 'cloudflare-workers-and-pages',
          score: 35,
          extracted: true,
          matchedAdapter: 'cloudflare'
        }
      }
    ]);
  });

  it('extracts previews from normalized GitLab pipeline and status checks', async () => {
    const result = await cloudflareChecksPreviewAdapter.resolve({
      repo: buildRepo({
        scmProvider: 'gitlab',
        scmBaseUrl: 'https://gitlab.example.com',
        projectPath: 'group/minions-demo',
        previewCheckName: 'workers-preview'
      }),
      checks: [
        {
          name: 'pipeline',
          detailsUrl: 'https://gitlab.example.com/group/minions-demo/-/pipelines/9',
          htmlUrl: 'https://gitlab.example.com/group/minions-demo/-/pipelines/9',
          summary: 'ref feature/minions',
          status: 'completed',
          conclusion: 'success',
          rawSource: 'gitlab_pipeline'
        },
        {
          name: 'workers-preview',
          detailsUrl: 'https://preview-minions-demo.abuiles.workers.dev',
          htmlUrl: 'https://preview-minions-demo.abuiles.workers.dev',
          summary: 'Preview URL: https://preview-minions-demo.abuiles.workers.dev',
          status: 'in_progress',
          rawSource: 'gitlab_status'
        }
      ]
    });

    expect(result.resolution.status).toBe('ready');
    expect(result.resolution.previewUrl).toBe('https://preview-minions-demo.abuiles.workers.dev');
    expect(result.compatibility.checks).toEqual([
      {
        name: 'workers-preview',
        appSlug: undefined,
        rawSource: 'gitlab_status',
        status: 'in_progress',
        conclusion: undefined,
        score: 105,
        matchedAdapter: 'cloudflare',
        extracted: true
      }
    ]);
  });
});

describe('inspectCloudflarePreviewDiscovery', () => {
  it('preserves structured diagnostics for inspected checks', () => {
    const result = inspectCloudflarePreviewDiscovery(buildRepo({ previewCheckName: 'Cloudflare Pages' }), [
      {
        name: 'Workers Builds: minions-demo',
        appSlug: 'cloudflare-workers-and-pages',
        summary: 'Preview Alias URL: https://abuiles-patch-1-minions-demo.abuiles.workers.dev',
        rawSource: 'github_check_run'
      }
    ]);

    expect(result.previewUrl).toBe('https://abuiles-patch-1-minions-demo.abuiles.workers.dev');
    expect(result.adapter).toBe('cloudflare');
    expect(result.source).toBe('summary');
    expect(result.checks).toEqual([
      {
        name: 'Workers Builds: minions-demo',
        appSlug: 'cloudflare-workers-and-pages',
        rawSource: 'github_check_run',
        score: 35,
        matchedAdapter: 'cloudflare',
        extracted: true
      }
    ]);
  });
});
