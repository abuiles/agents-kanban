import type { Repo, Task, AgentRun, PreviewAdapterKind } from '../../ui/domain/types';

export type PreviewCheck = {
  name?: string;
  detailsUrl?: string;
  htmlUrl?: string;
  summary?: string;
  appSlug?: string;
};

export type PreviewDiscoverySource = 'summary' | 'details_url' | 'html_url';

export type PreviewDiscoveryResult = {
  previewUrl?: string;
  adapter?: string;
  source?: PreviewDiscoverySource;
  matchedCheck?: string;
  checks: Array<{
    name?: string;
    appSlug?: string;
    score: number;
    matchedAdapter?: string;
    extracted: boolean;
  }>;
};

export type PreviewResolution = {
  previewUrl?: string;
  adapter: PreviewAdapterKind;
  explanation: string;
  diagnostics: Array<Record<string, string | number | boolean>>;
};

export type PreviewAdapterContext = {
  repo: Repo;
  task?: Task;
  run?: AgentRun;
  checks: PreviewCheck[];
};

export type PreviewAdapterResult = {
  resolution: PreviewResolution;
  compatibility: PreviewDiscoveryResult;
};

export type PreviewAdapter = {
  kind: PreviewAdapterKind;
  resolve(context: PreviewAdapterContext): PreviewAdapterResult;
};
