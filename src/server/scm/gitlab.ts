import { buildGitlabApiBaseUrl, buildGitlabGitUrl, getRepoProjectPath, getRepoScmBaseUrl } from '../../shared/scm';
import type { AgentRun, Repo, Task } from '../../ui/domain/types';
import type { ScmAdapter, ScmAdapterCredential, ScmCommitCheck, ScmReviewRef, ScmReviewState } from './adapter';
import type { ScmSourceRef } from './source-ref';

export class GitLabScmAdapter implements ScmAdapter {
  readonly provider = 'gitlab' as const;

  normalizeSourceRef(sourceRef: string, repo: Repo): ScmSourceRef {
    const trimmed = sourceRef.trim();
    const mergeRequestHeadMatch = trimmed.match(/^(?:refs\/)?merge-requests\/(\d+)\/head$/i);
    if (mergeRequestHeadMatch) {
      return {
        kind: 'review_head',
        value: `refs/merge-requests/${mergeRequestHeadMatch[1]}/head`,
        label: `MR !${mergeRequestHeadMatch[1]}`,
        reviewNumber: Number.parseInt(mergeRequestHeadMatch[1], 10),
        reviewProvider: this.provider
      };
    }

    if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
      return { kind: 'commit', value: trimmed, label: `commit ${trimmed.slice(0, 7)}` };
    }

    try {
      const url = new URL(trimmed);
      if (!isSupportedGitlabHost(url, repo)) {
        throw new Error(`Unsupported task source ref URL: ${trimmed}`);
      }

      const parsed = parseGitlabRepoUrl(url, repo);
      if (parsed.kind === 'merge_requests' && parsed.identifier) {
        return {
          kind: 'review_head',
          value: `refs/merge-requests/${parsed.identifier}/head`,
          label: `MR !${parsed.identifier}`,
          reviewNumber: Number.parseInt(parsed.identifier, 10),
          reviewProvider: this.provider
        };
      }

      if (parsed.kind === 'tree' && parsed.rest.length > 0) {
        const branch = decodeURIComponent(parsed.rest.join('/'));
        return { kind: 'branch', value: branch, label: `branch ${branch}` };
      }

      if (parsed.kind === 'commit' && parsed.identifier) {
        return { kind: 'commit', value: parsed.identifier, label: `commit ${parsed.identifier.slice(0, 7)}` };
      }

      throw new Error(`Unsupported task source ref URL: ${trimmed}`);
    } catch (error) {
      if (error instanceof TypeError) {
        return { kind: 'branch', value: trimmed, label: trimmed };
      }

      throw error;
    }
  }

  inferSourceRefFromTask(task: Pick<Task, 'sourceRef' | 'title' | 'description' | 'taskPrompt'>, repo: Repo) {
    if (task.sourceRef?.trim()) {
      return task.sourceRef.trim();
    }

    const text = [task.title, task.description, task.taskPrompt].filter(Boolean).join('\n');
    for (const match of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
      const candidate = trimTrailingPunctuation(match[0]);
      if (isSupportedGitlabSourceUrl(candidate, repo)) {
        return candidate;
      }
    }

    const mergeRequestMatch = text.match(/\b(?:mr|merge request)\s*[!#]?\s*(\d+)\b/i) ?? text.match(/(^|\s)!([0-9]+)\b/);
    if (mergeRequestMatch) {
      const reviewNumber = mergeRequestMatch[2] ?? mergeRequestMatch[1];
      return `refs/merge-requests/${reviewNumber}/head`;
    }

    const commitMatch = text.match(/\bcommit\s+([0-9a-f]{7,40})\b/i);
    if (commitMatch) {
      return commitMatch[1];
    }

    const branchMatch = text.match(/\b(?:from|use|checkout|start from)\s+branch(?: named| called|:)?\s+([A-Za-z0-9._/-]+)\b/i);
    if (branchMatch) {
      return branchMatch[1];
    }

    return undefined;
  }

  buildCloneUrl(repo: Repo, credential: ScmAdapterCredential) {
    return buildGitlabGitUrl(repo, credential.token);
  }

  async createReviewRequest(repo: Repo, task: Task, run: AgentRun, credential: ScmAdapterCredential): Promise<ScmReviewRef> {
    const response = await gitlabRequest(repo, '/merge_requests', credential.token, {
      method: 'POST',
      body: JSON.stringify({
        title: task.title,
        source_branch: run.branchName,
        target_branch: repo.defaultBranch,
        description: buildMergeRequestDescription(task, run)
      })
    });
    if (!response.ok) {
      throw new Error(`GitLab MR creation failed with status ${response.status}.`);
    }

    const payload = await response.json() as { iid: number; web_url: string };
    return { provider: this.provider, number: payload.iid, url: payload.web_url };
  }

  async upsertRunComment(repo: Repo, task: Task, run: AgentRun, credential: ScmAdapterCredential) {
    const reviewNumber = run.reviewNumber ?? run.prNumber;
    if (!reviewNumber) {
      return;
    }

    const marker = `<!-- agentboard-run:${run.runId} -->`;
    const body = [
      marker,
      `Task: ${task.title}`,
      '',
      `Run: ${run.runId}`,
      run.previewUrl ? `Preview: ${run.previewUrl}` : 'Preview: pending',
      run.artifactManifest?.before ? `Before: ${run.artifactManifest.before.key}` : undefined,
      run.artifactManifest?.after ? `After: ${run.artifactManifest.after.key}` : undefined,
      run.artifactManifest?.trace ? `Trace: ${run.artifactManifest.trace.key}` : undefined,
      run.artifactManifest?.video ? `Video: ${run.artifactManifest.video.key}` : undefined
    ].filter(Boolean).join('\n');

    const notesResponse = await gitlabRequest(repo, `/merge_requests/${reviewNumber}/notes?per_page=100`, credential.token);
    const notes = await notesResponse.json() as Array<{ id: number; body?: string }>;
    const existing = notes.find((note) => note.body?.includes(marker));
    if (existing) {
      await gitlabRequest(repo, `/merge_requests/${reviewNumber}/notes/${existing.id}`, credential.token, {
        method: 'PUT',
        body: JSON.stringify({ body })
      });
      return;
    }

    await gitlabRequest(repo, `/merge_requests/${reviewNumber}/notes`, credential.token, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
  }

  async getReviewState(repo: Repo, run: AgentRun, credential: ScmAdapterCredential): Promise<ScmReviewState> {
    const reviewNumber = run.reviewNumber ?? run.prNumber;
    if (!reviewNumber) {
      return { exists: false };
    }

    const response = await gitlabRequest(repo, `/merge_requests/${reviewNumber}`, credential.token);
    if (response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      throw new Error(`GitLab MR lookup failed with status ${response.status}.`);
    }

    const payload = await response.json() as {
      iid: number;
      web_url: string;
      state?: string;
      merged_at?: string | null;
      sha?: string;
      target_branch?: string;
    };

    return {
      exists: true,
      state: mapGitlabReviewState(payload.state, payload.merged_at),
      url: payload.web_url,
      number: payload.iid,
      headSha: payload.sha,
      baseBranch: payload.target_branch,
      mergedAt: payload.merged_at ?? undefined
    };
  }

  async listCommitChecks(repo: Repo, headSha: string, credential: ScmAdapterCredential): Promise<ScmCommitCheck[]> {
    const [pipelinesResponse, statusesResponse] = await Promise.all([
      gitlabRequest(repo, `/pipelines?sha=${encodeURIComponent(headSha)}&per_page=100`, credential.token),
      gitlabRequest(repo, `/repository/commits/${encodeURIComponent(headSha)}/statuses?per_page=100`, credential.token)
    ]);

    if (!pipelinesResponse.ok) {
      throw new Error(`GitLab pipeline lookup failed with status ${pipelinesResponse.status}.`);
    }
    if (!statusesResponse.ok) {
      throw new Error(`GitLab status lookup failed with status ${statusesResponse.status}.`);
    }

    const pipelines = await pipelinesResponse.json() as Array<{
      id: number;
      name?: string | null;
      web_url?: string | null;
      status?: string | null;
      ref?: string | null;
    }>;
    const statuses = await statusesResponse.json() as Array<{
      id?: number;
      name?: string | null;
      target_url?: string | null;
      description?: string | null;
      status?: string | null;
    }>;

    return [
      ...pipelines.map((pipeline) => ({
        name: pipeline.name ?? `Pipeline #${pipeline.id}`,
        detailsUrl: pipeline.web_url ?? undefined,
        htmlUrl: pipeline.web_url ?? undefined,
        summary: pipeline.ref ? `ref ${pipeline.ref}` : undefined,
        ...mapGitlabCheckState(pipeline.status),
        rawSource: 'gitlab_pipeline' as const
      })),
      ...statuses.map((status) => ({
        name: status.name ?? (status.id ? `Status #${status.id}` : 'status'),
        detailsUrl: status.target_url ?? undefined,
        htmlUrl: status.target_url ?? undefined,
        summary: status.description ?? undefined,
        ...mapGitlabCheckState(status.status),
        rawSource: 'gitlab_status' as const
      }))
    ];
  }

  async isCommitOnDefaultBranch(repo: Repo, commitSha: string, credential: ScmAdapterCredential) {
    const response = await gitlabRequest(
      repo,
      `/repository/compare?from=${encodeURIComponent(commitSha)}&to=${encodeURIComponent(repo.defaultBranch)}`,
      credential.token
    );
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`GitLab default-branch comparison failed with status ${response.status}.`);
    }

    const payload = await response.json() as { compare_same_ref?: boolean; commits?: Array<unknown> };
    return payload.compare_same_ref === true || (payload.commits?.length ?? 0) > 0;
  }
}

export const gitlabScmAdapter = new GitLabScmAdapter();

async function gitlabRequest(repo: Repo, path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${buildGitlabApiBaseUrl(repo)}/projects/${encodeURIComponent(getRepoProjectPath(repo))}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': token,
      'User-Agent': 'AgentsKanban',
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok && response.status >= 500) {
    throw new Error(`GitLab API request failed with status ${response.status}.`);
  }
  return response;
}

function buildMergeRequestDescription(task: Task, run: AgentRun) {
  return [
    `Task: ${task.title}`,
    '',
    task.description ?? '',
    task.sourceRef ? `Source ref: ${task.sourceRef}` : undefined,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    `Run ID: ${run.runId}`
  ].join('\n');
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[.,!?;:]+$/g, '');
}

function isSupportedGitlabSourceUrl(value: string, repo: Repo) {
  try {
    const url = new URL(value);
    if (!isSupportedGitlabHost(url, repo)) {
      return false;
    }

    const parsed = parseGitlabRepoUrl(url, repo);
    return ['merge_requests', 'tree', 'commit'].includes(parsed.kind);
  } catch {
    return false;
  }
}

function isSupportedGitlabHost(url: URL, repo: Repo) {
  return url.hostname.toLowerCase() === new URL(getRepoScmBaseUrl(repo)).hostname.toLowerCase();
}

function parseGitlabRepoUrl(url: URL, repo: Repo) {
  const trimmedPath = url.pathname.replace(/^\/+|\/+$/g, '');
  const marker = trimmedPath.indexOf('/-/');
  if (marker < 0) {
    throw new Error(`Unsupported task source ref URL: ${url.toString()}`);
  }

  const repoPath = decodeURIComponent(trimmedPath.slice(0, marker));
  const expectedRepoPath = getRepoProjectPath(repo);
  if (repoPath !== expectedRepoPath) {
    throw new Error(`Task source ref points to ${repoPath}, expected ${expectedRepoPath}.`);
  }

  const parts = trimmedPath.slice(marker + 3).split('/').filter(Boolean);
  return {
    kind: parts[0] ?? '',
    identifier: parts[1],
    rest: parts.slice(1)
  };
}

function mapGitlabReviewState(state?: string, mergedAt?: string | null): ScmReviewState['state'] {
  if (mergedAt) {
    return 'merged';
  }
  if (state === 'opened') {
    return 'open';
  }
  if (state === 'closed') {
    return 'closed';
  }
  if (state === 'merged') {
    return 'merged';
  }
  return undefined;
}

function mapGitlabCheckState(status?: string | null): Pick<ScmCommitCheck, 'status' | 'conclusion'> {
  switch (status) {
    case 'created':
    case 'pending':
    case 'preparing':
    case 'scheduled':
    case 'waiting_for_resource':
      return { status: 'queued' };
    case 'running':
      return { status: 'in_progress' };
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failed':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
    case 'cancelled':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'skipped':
      return { status: 'completed', conclusion: 'skipped' };
    case 'manual':
      return { status: 'completed', conclusion: 'action_required' };
    default:
      return {};
  }
}
