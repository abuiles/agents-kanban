import { normalizeRepoPreviewConfig, resolvePreviewCheckName } from '../../shared/preview';
import type { ScmCommitCheck } from '../scm/adapter';
import type { PreviewAdapter, PreviewDiscoveryResult } from './adapter';

const URL_LABEL_PATTERNS = [
  /Preview Alias URL:\s*(https:\/\/[^\s]+)/i,
  /Branch Preview URL:\s*(https:\/\/[^\s]+)/i,
  /Preview URL:\s*(https:\/\/[^\s]+)/i,
  /Commit Preview URL:\s*(https:\/\/[^\s]+)/i
];

type PreviewDiscoveryAdapter = {
  name: string;
  supports: (repo: Parameters<typeof normalizeRepoPreviewConfig>[0], check: ScmCommitCheck) => boolean;
  extractPreviewUrl: (repo: Parameters<typeof normalizeRepoPreviewConfig>[0], check: ScmCommitCheck) => { url?: string; source?: PreviewDiscoveryResult['source'] };
};

const adapters: PreviewDiscoveryAdapter[] = [
  {
    name: 'cloudflare',
    supports: (repo, check) => {
      const previewCheckName = resolvePreviewCheckName(repo);
      return (repo.previewProvider === 'cloudflare' && check.name === previewCheckName)
        || check.appSlug === 'cloudflare-workers-and-pages'
        || check.name?.startsWith('Workers Builds:')
        || check.detailsUrl?.includes('dash.cloudflare.com')
        || check.summary?.includes('Preview URL:')
        || check.summary?.includes('Preview Alias URL:')
        || false;
    },
    extractPreviewUrl: (_repo, check) => {
      if (check.summary) {
        for (const pattern of URL_LABEL_PATTERNS) {
          const match = check.summary.match(pattern);
          if (match?.[1]) {
            return { url: match[1], source: 'summary' };
          }
        }
      }
      return firstDirectPreviewUrl(check);
    }
  },
  {
    name: 'generic-direct-url',
    supports: (repo, check) => {
      const previewCheckName = resolvePreviewCheckName(repo);
      return check.name === previewCheckName || Boolean(firstDirectPreviewUrl(check));
    },
    extractPreviewUrl: (_repo, check) => firstDirectPreviewUrl(check)
  }
];

export const cloudflareChecksPreviewAdapter: PreviewAdapter = {
  kind: 'cloudflare_checks',
  async resolve({ repo, checks }) {
    const compatibility = inspectCloudflarePreviewDiscovery(repo, checks);

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
        status: compatibility.previewUrl ? 'ready' : 'pending',
        previewUrl: compatibility.previewUrl,
        adapter: 'cloudflare_checks',
        explanation,
        diagnostics: diagnostics.map((diagnostic) => ({
          code: diagnostic.extracted ? 'CLOUDFLARE_CHECK_MATCHED' : 'CLOUDFLARE_CHECK_SCANNED',
          level: diagnostic.extracted ? 'info' : 'error',
          message: diagnostic.extracted
            ? `Discovered preview URL from ${diagnostic.name}.`
            : `Scanned ${diagnostic.name} but found no preview URL.`,
          metadata: diagnostic
        }))
      }
    };
  }
};

export function inspectCloudflarePreviewDiscovery(
  repo: Parameters<typeof normalizeRepoPreviewConfig>[0],
  checks: ScmCommitCheck[]
): PreviewDiscoveryResult {
  const normalizedRepo = normalizeRepoPreviewConfig(repo);
  const orderedChecks = [...checks].sort((left, right) => scoreCheckRun(normalizedRepo, right) - scoreCheckRun(normalizedRepo, left));
  const compatibilityChecks: PreviewDiscoveryResult['checks'] = [];

  for (const check of orderedChecks) {
    const adapter = adapters.find((candidate) => candidate.supports(normalizedRepo, check));
    const score = scoreCheckRun(normalizedRepo, check);
    if (!adapter) {
      compatibilityChecks.push({
        name: check.name,
        appSlug: check.appSlug,
        rawSource: check.rawSource,
        status: check.status,
        conclusion: check.conclusion,
        score,
        extracted: false
      });
      continue;
    }

    const extraction = adapter.extractPreviewUrl(normalizedRepo, check);
    compatibilityChecks.push({
      name: check.name,
      appSlug: check.appSlug,
      rawSource: check.rawSource,
      status: check.status,
      conclusion: check.conclusion,
      score,
      matchedAdapter: adapter.name,
      extracted: Boolean(extraction.url)
    });
    if (extraction.url) {
      return {
        previewUrl: extraction.url,
        adapter: adapter.name,
        source: extraction.source,
        matchedCheck: check.name,
        checks: compatibilityChecks
      };
    }
  }

  return { checks: compatibilityChecks };
}

export function discoverCloudflarePreviewUrl(
  repo: Parameters<typeof normalizeRepoPreviewConfig>[0],
  checks: ScmCommitCheck[]
) {
  return inspectCloudflarePreviewDiscovery(repo, checks).previewUrl;
}

function scoreCheckRun(repo: Parameters<typeof normalizeRepoPreviewConfig>[0], check: ScmCommitCheck) {
  let score = 0;
  const previewCheckName = resolvePreviewCheckName(repo);

  if (previewCheckName && check.name === previewCheckName) {
    score += 100;
  }

  if (check.appSlug === 'cloudflare-workers-and-pages') {
    score += 20;
  }

  if (check.name?.startsWith('Workers Builds:')) {
    score += 10;
  }

  if (check.summary?.includes('Preview URL:') || check.summary?.includes('Preview Alias URL:')) {
    score += 5;
  }

  return score;
}

function firstDirectPreviewUrl(check: ScmCommitCheck) {
  if (isPreviewUrl(check.detailsUrl)) {
    return { url: check.detailsUrl, source: 'details_url' as const };
  }

  if (isPreviewUrl(check.htmlUrl)) {
    return { url: check.htmlUrl, source: 'html_url' as const };
  }

  return {};
}

function isPreviewUrl(value?: string) {
  return Boolean(value && (value.includes('.pages.dev') || value.includes('.workers.dev')));
}
