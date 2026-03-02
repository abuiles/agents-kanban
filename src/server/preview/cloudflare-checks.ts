import { inspectPreviewDiscovery } from '../preview-discovery';
import { resolvePreviewCheckName } from '../../shared/preview';
import type { PreviewAdapter } from './adapter';

export const cloudflareChecksPreviewAdapter: PreviewAdapter = {
  kind: 'cloudflare_checks',
  resolve: ({ repo, checks }) => {
    const compatibility = inspectPreviewDiscovery(
      { ...repo, previewCheckName: resolvePreviewCheckName(repo) },
      checks.map((check) => ({
        name: check.name,
        details_url: check.detailsUrl,
        html_url: check.htmlUrl,
        output: { summary: check.summary ?? null },
        app: { slug: check.appSlug }
      }))
    );

    const diagnostics = compatibility.checks.map((check) => ({
      name: check.name ?? '(unnamed check)',
      appSlug: check.appSlug ?? 'none',
      score: check.score,
      extracted: check.extracted,
      matchedAdapter: check.matchedAdapter ?? 'none'
    }));
    const explanation = compatibility.previewUrl
      ? `Preview discovery matched ${compatibility.matchedCheck ?? 'unknown check'} via ${compatibility.adapter ?? 'unknown adapter'} from ${compatibility.source ?? 'unknown source'}.`
      : 'Preview discovery found no usable preview URL.';

    return {
      compatibility,
      resolution: {
        previewUrl: compatibility.previewUrl,
        adapter: 'cloudflare_checks',
        explanation,
        diagnostics
      }
    };
  }
};
