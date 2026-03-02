import type { Repo, Task, AgentRun, PreviewAdapterKind } from '../../ui/domain/types';
import type { PreviewDiscoveryResult } from '../preview-discovery';

export type PreviewCheck = {
  name?: string;
  detailsUrl?: string;
  htmlUrl?: string;
  summary?: string;
  appSlug?: string;
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
