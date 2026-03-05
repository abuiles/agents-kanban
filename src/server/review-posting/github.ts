import { buildGithubApiBaseUrl, getRepoProjectPath } from '../../shared/scm';
import type { AutoReviewProvider, Repo, ReviewFinding } from '../../ui/domain/types';
import {
  ReviewPostingAdapter,
  type ReviewContextComment,
  type ReviewPostingFindingRecord,
  type ReviewPostingInput,
  type ReviewPostingResult,
  type ReviewReplyContext,
  type ReviewReplyFetchInput,
  retryReviewPosting,
  buildReviewFindingBody,
  buildReviewFindingMarker,
  buildReviewSummaryMarker,
  extractFindingIdsFromText,
  extractRunIdFromSummaryMarker,
  REVIEW_POSTING_MAX_ATTEMPTS
} from './adapter';

type GitHubPullRequestResponse = {
  head?: {
    sha?: string;
  };
};

type GitHubPullRequestFile = {
  filename?: string;
};

type GitHubReviewComment = {
  id?: number;
  body?: string;
  html_url?: string;
  in_reply_to_id?: number;
};

type GitHubIssueComment = {
  id?: number;
  body?: string;
  html_url?: string;
};

type ExistingFindingThread = {
  threadId: string;
  threadUrl?: string;
  isSummary: boolean;
};

type ExistingThreadMap = Map<string, ExistingFindingThread>;

type ExistingSummary = {
  threadId: string;
  threadUrl?: string;
};

export class GitHubReviewPostingAdapter implements ReviewPostingAdapter {
  readonly provider: AutoReviewProvider = 'github';

  async postFindings(input: ReviewPostingInput): Promise<ReviewPostingResult> {
    const reviewNumber = input.run.reviewNumber ?? input.run.prNumber;
    if (!reviewNumber) {
      return {
        provider: this.provider,
        findings: input.findings.map((finding) => ({
          findingId: finding.findingId,
          posted: false,
          inline: false,
          summary: false,
          reason: 'Review number is required for GitHub posting.'
        })),
        updatedFindings: [...input.findings],
        errors: ['Review number is missing for GitHub provider.']
      };
    }

    const results: ReviewPostingFindingRecord[] = [];
    const updatedFindings = [...input.findings];
    const needsSummary: ReviewFinding[] = [];
    const errors: string[] = [];
    const shouldInline = Boolean(input.postInline);

    let existingSummary: ExistingSummary | undefined;
    const findingsByMarker: ExistingThreadMap = new Map();

    const loadExistingThreads = async () => {
      const [reviewComments, issueComments] = await Promise.all([
        this.fetchReviewComments(input.repo, reviewNumber, input.credential.token),
        this.fetchIssueComments(input.repo, reviewNumber, input.credential.token)
      ]);
      existingSummary = this.fetchSummaryThread(issueComments, input.run.runId);
      const markerThreads = this.fetchExistingFindingThreads(reviewComments, issueComments, existingSummary?.threadId);
      findingsByMarker.clear();
      markerThreads.forEach((value, key) => {
        findingsByMarker.set(key, value);
      });
    };

    try {
      await loadExistingThreads();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const refreshSummary = async () => {
      const issueComments = await this.fetchIssueComments(input.repo, reviewNumber, input.credential.token);
      existingSummary = this.fetchSummaryThread(issueComments, input.run.runId);
      return existingSummary;
    };

    const headSha = await this.fetchPullRequestHeadSha(input.repo, reviewNumber, input.credential.token).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      return undefined;
    });
    const changedFiles = await this.fetchPullRequestChangedFiles(input.repo, reviewNumber, input.credential.token).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      return undefined;
    });

    for (const finding of input.findings) {
      const result: ReviewPostingFindingRecord = {
        findingId: finding.findingId,
        posted: false,
        inline: false,
        summary: false
      };
      const marker = buildReviewFindingMarker(finding.findingId, input.run.runId);
      const existingThread = findingsByMarker.get(finding.findingId);

      if (existingThread) {
        result.posted = true;
        result.inline = !existingThread.isSummary;
        result.summary = existingThread.isSummary;
        result.providerThreadId = existingThread.threadId;
        result.providerThreadUrl = existingThread.threadUrl;
        this.updateFindingRecord(updatedFindings, finding.findingId, result.providerThreadId);
        results.push(result);
        continue;
      }

      const normalizedFindingPath = typeof finding.filePath === 'string'
        ? finding.filePath.replace(/^\/+/, '')
        : undefined;
      const canInlineForPath = normalizedFindingPath && changedFiles
        ? changedFiles.has(normalizedFindingPath)
        : true;

      if (!shouldInline || !finding.filePath || !finding.lineStart || !headSha || !canInlineForPath) {
        needsSummary.push(finding);
        result.summary = true;
        result.reason = !shouldInline || !finding.filePath || !finding.lineStart
          ? 'Posting inline unavailable or disabled.'
          : !headSha
            ? 'Missing pull request metadata required for inline posting.'
            : 'Finding location is outside the pull request diff; posting as summary.';
        results.push(result);
        continue;
      }

      try {
        const response = await retryReviewPosting<{ threadId: string; threadUrl?: string }>(
          {
            operation: async () => {
              await loadExistingThreads();
              const existing = findingsByMarker.get(finding.findingId);
              if (existing) {
                return {
                  threadId: existing.threadId,
                  threadUrl: existing.threadUrl
                };
              }

              return this.postInlineFinding({
                repo: input.repo,
                reviewNumber,
                finding,
                marker,
                headSha,
                token: input.credential.token
              });
            },
            maxAttempts: REVIEW_POSTING_MAX_ATTEMPTS
          },
          `GitHub inline posting failed for finding ${finding.findingId}`
        );

        result.posted = true;
        result.inline = true;
        result.providerThreadId = response.threadId;
        result.providerThreadUrl = response.threadUrl;
        this.updateFindingRecord(updatedFindings, finding.findingId, result.providerThreadId);
      } catch (error) {
        needsSummary.push(finding);
        result.summary = true;
        result.reason = `Inline posting failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      results.push(result);
    }

    let summary: ReviewPostingResult['summary'];
    if (needsSummary.length > 0) {
      try {
        const postedSummary = await retryReviewPosting<{ threadId: string; threadUrl?: string }>(
          {
            operation: async () => {
              const observedSummary = await refreshSummary();
              if (observedSummary) {
                return observedSummary;
              }

              return this.upsertSummaryComment({
                repo: input.repo,
                reviewNumber,
                runId: input.run.runId,
                findings: needsSummary,
                token: input.credential.token,
                existingSummaryThreadId: existingSummary?.threadId
              });
            },
            maxAttempts: REVIEW_POSTING_MAX_ATTEMPTS
          },
          `GitHub summary posting failed for review run ${input.run.runId}`
        );

        summary = {
          posted: true,
          providerThreadId: postedSummary.threadId,
          providerThreadUrl: postedSummary.threadUrl
        };

        needsSummary.forEach((finding) => {
          const record = results.find((entry) => entry.findingId === finding.findingId);
          if (record) {
            record.posted = true;
            record.inline = false;
            record.summary = true;
            record.providerThreadId = postedSummary.threadId;
            record.providerThreadUrl = postedSummary.threadUrl;
            record.reason = undefined;
          }
          this.updateFindingRecord(updatedFindings, finding.findingId, postedSummary.threadId);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary = {
          posted: false,
          reason: message
        };
        errors.push(message);
        needsSummary.forEach((finding) => {
          const record = results.find((entry) => entry.findingId === finding.findingId);
          if (record) {
            record.summary = true;
            record.reason = record.reason ?? message;
          }
        });
      }
    }

    return {
      provider: this.provider,
      findings: results,
      updatedFindings,
      summary,
      errors
    };
  }

  async fetchReplyContext(input: ReviewReplyFetchInput): Promise<ReviewReplyContext> {
    const reviewNumber = input.run.reviewNumber ?? input.run.prNumber;
    if (!reviewNumber) {
      return {};
    }

    const [reviewComments, issueComments] = await Promise.all([
      this.fetchReviewComments(input.repo, reviewNumber, input.credential.token),
      this.fetchIssueComments(input.repo, reviewNumber, input.credential.token)
    ]);

    const targetIds = input.findingIds ? new Set(input.findingIds) : undefined;
    const replies: ReviewReplyContext = {};

    const rootById = new Map<number, GitHubReviewComment>();
    for (const comment of reviewComments) {
      if (typeof comment.id === 'number') {
        rootById.set(comment.id, comment);
      }
    }

    for (const comment of reviewComments) {
      if (typeof comment.in_reply_to_id !== 'number' || !comment.body?.trim()) {
        continue;
      }
      const root = rootById.get(comment.in_reply_to_id);
      if (!root?.body) {
        continue;
      }

      const defaultIds = extractFindingIdsFromText(root.body);
      const explicitIds = extractFindingIdsFromText(comment.body);
      const replyIds = explicitIds.length > 0 ? explicitIds : defaultIds;
      for (const findingId of replyIds) {
        if (targetIds && !targetIds.has(findingId)) {
          continue;
        }
        if (!replies[findingId]) {
          replies[findingId] = [];
        }
        replies[findingId].push(comment.body);
      }
    }

    const firstByFinding = new Map<string, number>();
    issueComments.forEach((comment, index) => {
      if (!comment.body) {
        return;
      }
      const markerIds = extractFindingIdsFromText(comment.body);
      const summaryRunId = extractRunIdFromSummaryMarker(comment.body);
      const findingIds = markerIds.length > 0
        ? markerIds
        : summaryRunId === input.run.runId
          ? extractFindingIdsFromText(comment.body)
          : [];

      for (const findingId of findingIds) {
        if (targetIds && !targetIds.has(findingId)) {
          continue;
        }
        const firstIndex = firstByFinding.get(findingId);
        if (firstIndex === undefined) {
          firstByFinding.set(findingId, index);
          continue;
        }
        if (firstIndex < index) {
          if (!replies[findingId]) {
            replies[findingId] = [];
          }
          replies[findingId].push(comment.body);
        }
      }
    });

    return replies;
  }

  async fetchReviewContextComments(input: ReviewReplyFetchInput): Promise<ReviewContextComment[]> {
    const reviewNumber = input.run.reviewNumber ?? input.run.prNumber;
    if (!reviewNumber) {
      return [];
    }

    const [reviewComments, issueComments] = await Promise.all([
      this.fetchReviewComments(input.repo, reviewNumber, input.credential.token),
      this.fetchIssueComments(input.repo, reviewNumber, input.credential.token)
    ]);

    const output: ReviewContextComment[] = [];

    reviewComments.forEach((comment, index) => {
      if (!comment.body?.trim()) {
        return;
      }
      const label = comment.in_reply_to_id ? `reply to ${comment.in_reply_to_id}` : 'review comment';
      output.push({ source: 'review', body: `GitHub ${label} #${index + 1}: ${comment.body}` });
    });

    issueComments.forEach((comment, index) => {
      if (!comment.body?.trim()) {
        return;
      }
      output.push({ source: 'issue', body: `GitHub issue comment #${index + 1}: ${comment.body}` });
    });

    return output;
  }

  private async fetchPullRequestHeadSha(repo: Repo, reviewNumber: number, token: string) {
    const response = await this.requestJson<GitHubPullRequestResponse>(repo, `/pulls/${reviewNumber}`, token);
    const headSha = response.head?.sha;
    if (!headSha) {
      throw new Error('Pull request head SHA is not available.');
    }
    return headSha;
  }

  private async fetchPullRequestChangedFiles(repo: Repo, reviewNumber: number, token: string): Promise<Set<string>> {
    const files = await this.requestJson<GitHubPullRequestFile[]>(repo, `/pulls/${reviewNumber}/files?per_page=100`, token);
    const changed = new Set<string>();
    for (const file of files) {
      if (typeof file.filename === 'string' && file.filename.trim()) {
        changed.add(file.filename.trim().replace(/^\/+/, ''));
      }
    }
    return changed;
  }

  private async postInlineFinding(input: {
    repo: Repo;
    reviewNumber: number;
    finding: ReviewFinding;
    marker: string;
    headSha: string;
    token: string;
  }): Promise<{ threadId: string; threadUrl?: string }> {
    const line = input.finding.lineStart ?? 1;
    const response = await this.requestJson<GitHubReviewComment>(
      input.repo,
      `/pulls/${input.reviewNumber}/comments`,
      input.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: buildReviewFindingBody({
            finding: input.finding,
            marker: input.marker,
            includeLocation: true
          }),
          commit_id: input.headSha,
          path: input.finding.filePath,
          line,
          side: 'RIGHT'
        })
      }
    );

    if (!response.id) {
      throw new Error('GitHub inline posting response did not contain a comment id.');
    }

    return {
      threadId: String(response.id),
      threadUrl: response.html_url
    };
  }

  private async upsertSummaryComment(input: {
    repo: Repo;
    reviewNumber: number;
    runId: string;
    findings: ReviewFinding[];
    token: string;
    existingSummaryThreadId?: string;
  }): Promise<{ threadId: string; threadUrl?: string }> {
    const marker = buildReviewSummaryMarker(input.runId);
    const body = [
      marker,
      '# AgentsKanban Review Notes',
      '',
      'The following findings were posted in summary form because inline posting was not available:',
      ...input.findings.map((finding, index) => {
        const findingBody = buildReviewFindingBody({
          finding,
          marker: buildReviewFindingMarker(finding.findingId, input.runId),
          includeLocation: true
        });
        return `${index + 1}. ${findingBody}`;
      }),
      ''
    ].join('\n');

    if (input.existingSummaryThreadId) {
      const response = await this.requestJson<GitHubIssueComment>(
        input.repo,
        `/issues/comments/${input.existingSummaryThreadId}`,
        input.token,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body })
        }
      );
      return {
        threadId: input.existingSummaryThreadId,
        threadUrl: response.html_url
      };
    }

    const response = await this.requestJson<GitHubIssueComment>(
      input.repo,
      `/issues/${input.reviewNumber}/comments`,
      input.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      }
    );

    if (!response.id) {
      throw new Error('GitHub summary posting response did not contain a comment id.');
    }

    return {
      threadId: String(response.id),
      threadUrl: response.html_url
    };
  }

  private fetchExistingFindingThreads(
    reviewComments: GitHubReviewComment[],
    issueComments: GitHubIssueComment[],
    summaryThreadId?: string
  ): ExistingThreadMap {
    const map: ExistingThreadMap = new Map();

    for (const comment of reviewComments) {
      if (!comment.id || !comment.body) {
        continue;
      }
      for (const findingId of extractFindingIdsFromText(comment.body)) {
        map.set(findingId, {
          threadId: String(comment.id),
          threadUrl: comment.html_url,
          isSummary: false
        });
      }
    }

    for (const comment of issueComments) {
      if (!comment.id || !comment.body) {
        continue;
      }
      const isSummary = summaryThreadId !== undefined && String(comment.id) === summaryThreadId;
      for (const findingId of extractFindingIdsFromText(comment.body)) {
        map.set(findingId, {
          threadId: String(comment.id),
          threadUrl: comment.html_url,
          isSummary
        });
      }
    }

    return map;
  }

  private fetchSummaryThread(issueComments: GitHubIssueComment[], runId: string): ExistingSummary | undefined {
    const summaryMarker = buildReviewSummaryMarker(runId);
    for (const comment of issueComments) {
      if (!comment.id || !comment.body?.includes(summaryMarker)) {
        continue;
      }
      return {
        threadId: String(comment.id),
        threadUrl: comment.html_url
      };
    }
    return undefined;
  }

  private async fetchReviewComments(repo: Repo, reviewNumber: number, token: string): Promise<GitHubReviewComment[]> {
    return this.requestJson<GitHubReviewComment[]>(repo, `/pulls/${reviewNumber}/comments?per_page=100`, token);
  }

  private async fetchIssueComments(repo: Repo, reviewNumber: number, token: string): Promise<GitHubIssueComment[]> {
    return this.requestJson<GitHubIssueComment[]>(repo, `/issues/${reviewNumber}/comments?per_page=100`, token);
  }

  private async requestJson<T>(repo: Repo, path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.buildApiUrl(repo, path), {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'AgentsKanban',
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      const suffix = responseText ? ` Response: ${responseText.slice(0, 500)}` : '';
      throw new Error(`GitHub review-posting request failed with status ${response.status}.${suffix}`);
    }

    return response.json() as Promise<T>;
  }

  private buildApiUrl(repo: Repo, path: string) {
    return `${buildGithubApiBaseUrl(repo)}/repos/${getRepoProjectPath(repo)}${path}`;
  }

  private updateFindingRecord(updatedFindings: ReviewFinding[], findingId: string, providerThreadId?: string) {
    const index = updatedFindings.findIndex((existing) => existing.findingId === findingId);
    if (index >= 0) {
      updatedFindings[index] = {
        ...updatedFindings[index],
        providerThreadId
      };
    }
  }
}
