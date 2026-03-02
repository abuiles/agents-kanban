import type { Repo } from '../ui/domain/types';
import type { PreviewDiscoveryResult } from './preview/adapter';
import { discoverCloudflarePreviewUrl, inspectCloudflarePreviewDiscovery } from './preview/cloudflare-checks';

export type PreviewDiscoveryCheckRun = {
  name?: string;
  details_url?: string;
  html_url?: string;
  output?: {
    summary?: string | null;
  };
  app?: {
    slug?: string;
  };
};

export function discoverPreviewUrl(repo: Repo, checkRuns: PreviewDiscoveryCheckRun[]) {
  return discoverCloudflarePreviewUrl(repo, mapCheckRuns(checkRuns));
}

export function inspectPreviewDiscovery(repo: Repo, checkRuns: PreviewDiscoveryCheckRun[]): PreviewDiscoveryResult {
  return inspectCloudflarePreviewDiscovery(repo, mapCheckRuns(checkRuns));
}

function mapCheckRuns(checkRuns: PreviewDiscoveryCheckRun[]) {
  return checkRuns.map((check) => ({
    name: check.name,
    detailsUrl: check.details_url,
    htmlUrl: check.html_url,
    summary: check.output?.summary ?? undefined,
    appSlug: check.app?.slug
  }));
}
