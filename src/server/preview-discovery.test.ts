import { describe, expect, it } from 'vitest';
import { discoverPreviewUrl, inspectPreviewDiscovery } from './preview-discovery';
import type { Repo } from '../ui/domain/types';

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

describe('discoverPreviewUrl', () => {
  it('extracts the Cloudflare preview alias URL from check run summaries', () => {
    const previewUrl = discoverPreviewUrl(buildRepo(), [
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
    ]);

    expect(previewUrl).toBe('https://abuiles-patch-1-minions-demo.abuiles.workers.dev');
  });

  it('uses the configured check name when selecting a provider-specific check run', () => {
    const previewUrl = discoverPreviewUrl(buildRepo({ previewCheckName: 'Workers Builds: minions-demo' }), [
      {
        name: 'Unrelated check',
        detailsUrl: 'https://unrelated.example.com',
        rawSource: 'github_check_run'
      },
      {
        name: 'Workers Builds: minions-demo',
        appSlug: 'cloudflare-workers-and-pages',
        summary: 'Preview URL: https://commit-minions-demo.abuiles.workers.dev',
        rawSource: 'github_check_run'
      }
    ]);

    expect(previewUrl).toBe('https://commit-minions-demo.abuiles.workers.dev');
  });

  it('uses previewConfig.checkName via compatibility mapping', () => {
    const previewUrl = discoverPreviewUrl(buildRepo({
      previewAdapter: 'cloudflare_checks',
      previewConfig: { checkName: 'Workers Builds: minions-demo' },
      previewCheckName: undefined
    }), [
      {
        name: 'Workers Builds: minions-demo',
        appSlug: 'cloudflare-workers-and-pages',
        summary: 'Preview URL: https://commit-minions-demo.abuiles.workers.dev',
        rawSource: 'github_check_run'
      }
    ]);

    expect(previewUrl).toBe('https://commit-minions-demo.abuiles.workers.dev');
  });

  it('falls back to Cloudflare heuristics when the configured check name does not match', () => {
    const previewUrl = discoverPreviewUrl(buildRepo({ previewCheckName: 'Cloudflare Pages' }), [
      {
        name: 'Workers Builds: minions-demo',
        appSlug: 'cloudflare-workers-and-pages',
        detailsUrl: 'https://dash.cloudflare.com/account/workers/services/view/minions-demo/builds/abc123',
        summary: 'Preview Alias URL: https://abuiles-patch-1-minions-demo.abuiles.workers.dev',
        rawSource: 'github_check_run'
      }
    ]);

    expect(previewUrl).toBe('https://abuiles-patch-1-minions-demo.abuiles.workers.dev');
  });

  it('detects Cloudflare preview checks even when the repo preview provider is unset', () => {
    const previewUrl = discoverPreviewUrl(buildRepo({ previewProvider: undefined, previewCheckName: undefined }), [
      {
        name: 'Workers Builds: minions-demo',
        appSlug: 'cloudflare-workers-and-pages',
        detailsUrl: 'https://dash.cloudflare.com/account/workers/services/view/minions-demo/builds/abc123',
        summary: 'Preview Alias URL: https://abuiles-patch-1-minions-demo.abuiles.workers.dev',
        rawSource: 'github_check_run'
      }
    ]);

    expect(previewUrl).toBe('https://abuiles-patch-1-minions-demo.abuiles.workers.dev');
  });

  it('falls back to direct preview URLs for non-Cloudflare checks', () => {
    const previewUrl = discoverPreviewUrl(buildRepo({ previewProvider: undefined, previewCheckName: undefined }), [
      {
        name: 'Deploy Preview',
        detailsUrl: 'https://deploy-preview-42.pages.dev',
        rawSource: 'github_check_run'
      }
    ]);

    expect(previewUrl).toBe('https://deploy-preview-42.pages.dev');
  });

  it('extracts previews from normalized GitLab status checks', () => {
    const previewUrl = discoverPreviewUrl(buildRepo({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/minions-demo',
      previewCheckName: 'workers-preview'
    }), [
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
    ]);

    expect(previewUrl).toBe('https://preview-minions-demo.abuiles.workers.dev');
  });

  it('returns debug metadata for inspected checks', () => {
    const result = inspectPreviewDiscovery(buildRepo({ previewCheckName: 'Cloudflare Pages' }), [
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
