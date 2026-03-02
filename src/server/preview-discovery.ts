import type { Repo } from '../ui/domain/types';
import type { ScmCommitCheck } from './scm/adapter';
import type { PreviewDiscoveryResult } from './preview/adapter';
import { discoverCloudflarePreviewUrl, inspectCloudflarePreviewDiscovery } from './preview/cloudflare-checks';

export function discoverPreviewUrl(repo: Repo, checks: ScmCommitCheck[]) {
  return discoverCloudflarePreviewUrl(repo, checks);
}

export function inspectPreviewDiscovery(repo: Repo, checks: ScmCommitCheck[]): PreviewDiscoveryResult {
  return inspectCloudflarePreviewDiscovery(repo, checks);
}
