import type { Repo } from '../ui/domain/types';

type GithubCheckRun = {
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
  supports: (repo: Repo, checkRun: GithubCheckRun) => boolean;
  extractPreviewUrl: (repo: Repo, checkRun: GithubCheckRun) => { url?: string; source?: 'summary' | 'details_url' | 'html_url' };
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
      return (repo.previewProvider === 'cloudflare' && checkRun.name === repo.previewCheckName)
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
      return checkRun.name === repo.previewCheckName || Boolean(firstDirectPreviewUrl(checkRun));
    },
    extractPreviewUrl: (_repo, checkRun) => firstDirectPreviewUrl(checkRun)
  }
];

export function discoverPreviewUrl(repo: Repo, checkRuns: GithubCheckRun[]) {
  return inspectPreviewDiscovery(repo, checkRuns).previewUrl;
}

export function inspectPreviewDiscovery(repo: Repo, checkRuns: GithubCheckRun[]): PreviewDiscoveryResult {
  const orderedCheckRuns = [...checkRuns].sort((left, right) => scoreCheckRun(repo, right) - scoreCheckRun(repo, left));
  const checks: PreviewDiscoveryResult['checks'] = [];

  for (const checkRun of orderedCheckRuns) {
    const adapter = adapters.find((candidate) => candidate.supports(repo, checkRun));
    const score = scoreCheckRun(repo, checkRun);
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

function scoreCheckRun(repo: Repo, checkRun: GithubCheckRun) {
  let score = 0;

  if (repo.previewCheckName && checkRun.name === repo.previewCheckName) {
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

function firstDirectPreviewUrl(checkRun: GithubCheckRun) {
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
