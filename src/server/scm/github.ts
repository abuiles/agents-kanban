import { buildGithubApiBaseUrl, buildGithubGitUrl, getRepoProjectPath, getRepoScmBaseUrl } from '../../shared/scm';
import type { AgentRun, Repo, Task } from '../../ui/domain/types';
import type { NormalizedScmSourceRef, ScmAdapter, ScmAdapterCredential, ScmCommitCheck, ScmReviewRef, ScmReviewState } from './adapter';

export class GitHubScmAdapter implements ScmAdapter {
  readonly provider = 'github' as const;

  normalizeSourceRef(sourceRef: string, repo: Repo): NormalizedScmSourceRef {
    const trimmed = sourceRef.trim();
    const pullHeadMatch = trimmed.match(/^(?:refs\/)?pull\/(\d+)\/head$/i);
    if (pullHeadMatch) {
      return { fetchSpec: `pull/${pullHeadMatch[1]}/head`, label: `PR #${pullHeadMatch[1]}` };
    }

    if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
      return { fetchSpec: trimmed, label: `commit ${trimmed.slice(0, 7)}` };
    }

    try {
      const url = new URL(trimmed);
      if (!getSupportedGithubHosts(repo).includes(url.hostname.toLowerCase())) {
        throw new Error(`Unsupported task source ref URL: ${trimmed}`);
      }

      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 4) {
        throw new Error(`Unsupported task source ref URL: ${trimmed}`);
      }

      const repoSlug = `${parts[0]}/${parts[1]}`;
      const expectedRepoSlug = getRepoProjectPath(repo);
      if (repoSlug !== expectedRepoSlug) {
        throw new Error(`Task source ref points to ${repoSlug}, expected ${expectedRepoSlug}.`);
      }

      if (parts[2] === 'pull' && parts[3]) {
        return { fetchSpec: `pull/${parts[3]}/head`, label: `PR #${parts[3]}` };
      }

      if (parts[2] === 'tree' && parts.length >= 4) {
        const branch = decodeURIComponent(parts.slice(3).join('/'));
        return { fetchSpec: branch, label: `branch ${branch}` };
      }

      if (parts[2] === 'commit' && parts[3]) {
        return { fetchSpec: parts[3], label: `commit ${parts[3].slice(0, 7)}` };
      }

      throw new Error(`Unsupported task source ref URL: ${trimmed}`);
    } catch (error) {
      if (error instanceof TypeError) {
        return { fetchSpec: trimmed, label: trimmed };
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
      if (isSupportedGithubSourceUrl(candidate, repo)) {
        return candidate;
      }
    }

    const prMatch = text.match(/\b(?:pr|pull request)\s*#\s*(\d+)\b/i);
    if (prMatch) {
      return `pull/${prMatch[1]}/head`;
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
    return buildGithubGitUrl(repo, credential.token);
  }

  async createReviewRequest(repo: Repo, task: Task, run: AgentRun, credential: ScmAdapterCredential): Promise<ScmReviewRef> {
    const response = await githubRequest(repo, '/pulls', credential.token, {
      method: 'POST',
      body: JSON.stringify({
        title: task.title,
        head: run.branchName,
        base: repo.defaultBranch,
        body: buildPullRequestBody(task, run)
      })
    });
    if (!response.ok) {
      throw new Error(`GitHub PR creation failed with status ${response.status}.`);
    }
    const payload = await response.json() as { number: number; html_url: string };
    return { number: payload.number, url: payload.html_url };
  }

  async upsertRunComment(repo: Repo, task: Task, run: AgentRun, credential: ScmAdapterCredential) {
    if (!run.prNumber) {
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

    const commentsResponse = await githubRequest(repo, `/issues/${run.prNumber}/comments`, credential.token);
    const comments = await commentsResponse.json() as Array<{ id: number; body?: string }>;
    const existing = comments.find((comment) => comment.body?.includes(marker));
    if (existing) {
      await githubRequest(repo, `/issues/comments/${existing.id}`, credential.token, {
        method: 'PATCH',
        body: JSON.stringify({ body })
      });
      return;
    }

    await githubRequest(repo, `/issues/${run.prNumber}/comments`, credential.token, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
  }

  async getReviewState(repo: Repo, run: AgentRun, credential: ScmAdapterCredential): Promise<ScmReviewState> {
    if (!run.prNumber) {
      return { exists: false };
    }

    const response = await githubRequest(repo, `/pulls/${run.prNumber}`, credential.token);
    if (response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      throw new Error(`GitHub PR lookup failed with status ${response.status}.`);
    }

    const payload = await response.json() as {
      number: number;
      html_url: string;
      state?: 'open' | 'closed';
      merged_at?: string | null;
      head?: { sha?: string };
      base?: { ref?: string };
    };

    return {
      exists: true,
      state: payload.merged_at ? 'merged' : payload.state === 'closed' ? 'closed' : 'open',
      url: payload.html_url,
      number: payload.number,
      headSha: payload.head?.sha,
      baseBranch: payload.base?.ref,
      mergedAt: payload.merged_at ?? undefined
    };
  }

  async listCommitChecks(repo: Repo, headSha: string, credential: ScmAdapterCredential): Promise<ScmCommitCheck[]> {
    const response = await githubRequest(repo, `/commits/${headSha}/check-runs`, credential.token);
    if (!response.ok) {
      throw new Error(`GitHub check-runs lookup failed with status ${response.status}.`);
    }

    const payload = await response.json() as {
      check_runs?: Array<{
        name?: string;
        details_url?: string;
        html_url?: string;
        status?: 'queued' | 'in_progress' | 'completed';
        conclusion?: ScmCommitCheck['conclusion'];
        output?: { summary?: string | null };
        app?: { slug?: string };
      }>;
    };

    return (payload.check_runs ?? []).map((checkRun) => ({
      name: checkRun.name,
      detailsUrl: checkRun.details_url,
      htmlUrl: checkRun.html_url,
      status: checkRun.status,
      conclusion: checkRun.conclusion,
      summary: checkRun.output?.summary ?? undefined,
      appSlug: checkRun.app?.slug,
      rawSource: 'github_check_run'
    }));
  }

  async isCommitOnDefaultBranch(repo: Repo, commitSha: string, credential: ScmAdapterCredential) {
    const response = await githubRequest(
      repo,
      `/compare/${encodeURIComponent(commitSha)}...${encodeURIComponent(repo.defaultBranch)}`,
      credential.token
    );
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`GitHub default-branch comparison failed with status ${response.status}.`);
    }

    const payload = await response.json() as { status?: string };
    return payload.status === 'behind' || payload.status === 'identical';
  }
}

export const githubScmAdapter = new GitHubScmAdapter();

async function githubRequest(repo: Repo, path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${buildGithubApiBaseUrl(repo)}/repos/${getRepoProjectPath(repo)}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'AgentsKanban',
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok && response.status >= 500) {
    throw new Error(`GitHub API request failed with status ${response.status}.`);
  }
  return response;
}

function buildPullRequestBody(task: Task, run: AgentRun) {
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

function isSupportedGithubSourceUrl(value: string, repo: Repo) {
  try {
    const url = new URL(value);
    if (!getSupportedGithubHosts(repo).includes(url.hostname.toLowerCase())) {
      return false;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4) {
      return false;
    }

    return ['pull', 'tree', 'commit'].includes(parts[2]);
  } catch {
    return false;
  }
}

function getSupportedGithubHosts(repo: Repo) {
  const baseHost = new URL(getRepoScmBaseUrl(repo)).hostname.toLowerCase();
  if (baseHost === 'github.com') {
    return ['github.com', 'www.github.com'];
  }
  return [baseHost];
}
