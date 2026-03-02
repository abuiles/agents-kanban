import type { AgentRun, Repo, ScmProvider, Task } from '../../ui/domain/types';

export type ScmAdapterCredential = {
  token: string;
};

export type NormalizedScmSourceRef = {
  fetchSpec: string;
  label: string;
};

export type ScmReviewRef = {
  number: number;
  url: string;
};

export type ScmReviewState = {
  exists: boolean;
  state?: 'open' | 'merged' | 'closed';
  url?: string;
  number?: number;
  headSha?: string;
  baseBranch?: string;
  mergedAt?: string;
};

export type ScmCommitCheck = {
  name?: string;
  detailsUrl?: string;
  htmlUrl?: string;
  summary?: string;
  appSlug?: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped' | 'action_required';
  rawSource: 'github_check_run' | 'gitlab_pipeline' | 'gitlab_status';
};

export type ScmAdapter = {
  provider: ScmProvider;
  normalizeSourceRef(sourceRef: string, repo: Repo): NormalizedScmSourceRef;
  inferSourceRefFromTask(task: Pick<Task, 'sourceRef' | 'title' | 'description' | 'taskPrompt'>, repo: Repo): string | undefined;
  buildCloneUrl(repo: Repo, credential: ScmAdapterCredential): string;
  createReviewRequest(repo: Repo, task: Task, run: AgentRun, credential: ScmAdapterCredential): Promise<ScmReviewRef>;
  upsertRunComment(repo: Repo, task: Task, run: AgentRun, credential: ScmAdapterCredential): Promise<void>;
  getReviewState(repo: Repo, run: AgentRun, credential: ScmAdapterCredential): Promise<ScmReviewState>;
  listCommitChecks(repo: Repo, headSha: string, credential: ScmAdapterCredential): Promise<ScmCommitCheck[]>;
  isCommitOnDefaultBranch(repo: Repo, commitSha: string, credential: ScmAdapterCredential): Promise<boolean>;
};
