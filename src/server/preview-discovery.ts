import type { Repo } from '../ui/domain/types';
import { normalizeRepoPreviewConfig, resolvePreviewCheckName } from '../shared/preview';

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

type PreviewDiscoveryAdapter = {
  name: string;
  supports: (repo: Repo, checkRun: PreviewDiscoveryCheckRun) => boolean;
  extractPreviewUrl: (repo: Repo, checkRun: PreviewDiscoveryCheckRun) => { url?: string; source?: 'summary' | 'details_url' | 'html_url' };
};

export type PreviewDiscoveryResult = {
  previewUrl?: string;
  adapter?: string;
  source?: 'summary' | 'details_url' | 'html_url';
  matchedCheck?: string;
  checks: Array<{
    name?: string;
    appSlug?: string;
    score: number;
    matchedAdapter?: string;
    extracted: boolean;
  }>;
};

const URL_LABEL_PATTERNS = [
  /Preview Alias URL:\s*(https:\/\/[^\s]+)/i,
  /Branch Preview URL:\s*(https:\/\/[^\s]+)/i,
  /Preview URL:\s*(https:\/\/[^\s]+)/i,
  /Commit Preview URL:\s*(https:\/\/[^\s]+)/i
];

const adapters: PreviewDiscoveryAdapter[] = [
  {
    name: 'cloudflare',
    supports: (repo, checkRun) => {
      const normalizedRepo = normalizeRepoPreviewConfig(repo);
      const previewCheckName = resolvePreviewCheckName(normalizedRepo);
      return (normalizedRepo.previewProvider === 'cloudflare' && checkRun.name === previewCheckName)
        || checkRun.app?.slug === 'cloudflare-workers-and-pages'
        || checkRun.name?.startsWith('Workers Builds:')
        || checkRun.details_url?.includes('dash.cloudflare.com')
        || checkRun.output?.summary?.includes('Preview URL:')
        || checkRun.output?.summary?.includes('Preview Alias URL:')
        || false;
    },
    extractPreviewUrl: (_repo, checkRun) => {
      const summary = checkRun.output?.summary;
      if (summary) {
        for (const pattern of URL_LABEL_PATTERNS) {
          const match = summary.match(pattern);
          if (match?.[1]) {
            return { url: match[1], source: 'summary' };
          }
        }
      }

      return firstDirectPreviewUrl(checkRun);
    }
  },
  {
    name: 'generic-direct-url',
    supports: (repo, checkRun) => {
      const previewCheckName = resolvePreviewCheckName(repo);
      return checkRun.name === previewCheckName || Boolean(firstDirectPreviewUrl(checkRun));
    },
    extractPreviewUrl: (_repo, checkRun) => firstDirectPreviewUrl(checkRun)
  }
];

export function discoverPreviewUrl(repo: Repo, checkRuns: PreviewDiscoveryCheckRun[]) {
  return inspectPreviewDiscovery(repo, checkRuns).previewUrl;
}

export function inspectPreviewDiscovery(repo: Repo, checkRuns: PreviewDiscoveryCheckRun[]): PreviewDiscoveryResult {
  const normalizedRepo = normalizeRepoPreviewConfig(repo);
  const orderedCheckRuns = [...checkRuns].sort((left, right) => scoreCheckRun(normalizedRepo, right) - scoreCheckRun(normalizedRepo, left));
  const checks: PreviewDiscoveryResult['checks'] = [];

  for (const checkRun of orderedCheckRuns) {
    const adapter = adapters.find((candidate) => candidate.supports(normalizedRepo, checkRun));
    const score = scoreCheckRun(normalizedRepo, checkRun);
    if (!adapter) {
      checks.push({
        name: checkRun.name,
        appSlug: checkRun.app?.slug,
        score,
        extracted: false
      });
      continue;
    }

    const extraction = adapter.extractPreviewUrl(repo, checkRun);
    checks.push({
      name: checkRun.name,
      appSlug: checkRun.app?.slug,
      score,
      matchedAdapter: adapter.name,
      extracted: Boolean(extraction.url)
    });
    if (extraction.url) {
      return {
        previewUrl: extraction.url,
        adapter: adapter.name,
        source: extraction.source,
        matchedCheck: checkRun.name,
        checks
      };
    }
  }

  return { checks };
}

function scoreCheckRun(repo: Repo, checkRun: PreviewDiscoveryCheckRun) {
  let score = 0;
  const previewCheckName = resolvePreviewCheckName(repo);

  if (previewCheckName && checkRun.name === previewCheckName) {
    score += 100;
  }

  if (checkRun.app?.slug === 'cloudflare-workers-and-pages') {
    score += 20;
  }

  if (checkRun.name?.startsWith('Workers Builds:')) {
    score += 10;
  }

  if (checkRun.output?.summary?.includes('Preview URL:') || checkRun.output?.summary?.includes('Preview Alias URL:')) {
    score += 5;
  }

  return score;
}

function firstDirectPreviewUrl(checkRun: PreviewDiscoveryCheckRun) {
  if (isPreviewUrl(checkRun.details_url)) {
    return { url: checkRun.details_url, source: 'details_url' as const };
  }

  if (isPreviewUrl(checkRun.html_url)) {
    return { url: checkRun.html_url, source: 'html_url' as const };
  }

  return {};
}

function isPreviewUrl(value?: string) {
  return Boolean(value && (value.includes('.pages.dev') || value.includes('.workers.dev')));
}
