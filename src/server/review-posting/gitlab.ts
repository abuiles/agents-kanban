import { buildGitlabApiBaseUrl, getRepoProjectPath } from '../../shared/scm';
import type { AutoReviewProvider, Repo, ReviewFinding } from '../../ui/domain/types';
import {
  ReviewPostingAdapter,
  type ReviewPostingFindingRecord,
  type ReviewPostingInput,
  type ReviewPostingResult,
  type ReviewReplyContext,
  type ReviewReplyFetchInput,
  buildReviewFindingBody,
  buildReviewFindingMarker,
  buildReviewSummaryMarker,
  extractFindingIdsFromText,
  extractRunIdFromSummaryMarker
} from './adapter';

type GitLabDiscussionNote = {
  id?: string | number;
  body?: string;
  url?: string;
};

type GitLabDiscussion = {
  notes?: GitLabDiscussionNote[];
};

type GitLabDiscussionResponse = {
  id?: string | number;
  notes?: GitLabDiscussionNote[];
};

type GitLabNoteResponse = {
  id?: string | number;
  url?: string;
};

type GitLabMergeRequestResponse = {
  diff_refs?: {
    base_sha?: string;
    head_sha?: string;
    start_sha?: string;
  };
};

type ExistingFindingThread = {
  noteId: string;
  noteUrl?: string;
  isSummary: boolean;
};

type ExistingThreadMap = Map<string, ExistingFindingThread>;

type ExistingSummary = {
  noteId: string;
  noteUrl?: string;
};

type GitLabPostingInput = {
  repo: Repo;
  reviewNumber: number;
  finding: ReviewFinding;
  marker: string;
  diffRefs: NonNullable<GitLabMergeRequestResponse['diff_refs']>;
  token: string;
};

export class GitLabReviewPostingAdapter implements ReviewPostingAdapter {
  readonly provider: AutoReviewProvider = 'gitlab';

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
          reason: 'Review number is required for GitLab posting.'
        })),
        updatedFindings: [...input.findings],
        errors: ['Review number is missing for GitLab provider.']
      };
    }

    const results: ReviewPostingFindingRecord[] = [];
    const updatedFindings = [...input.findings];
    const needsSummary: ReviewFinding[] = [];
    const errors: string[] = [];
    const shouldInline = Boolean(input.postInline);

    let existingSummary: ExistingSummary | undefined;
    const findingsByMarker = new Map<string, ExistingFindingThread>();
    try {
      const discussions = await this.fetchDiscussions(input.repo, reviewNumber, input.credential.token);
      existingSummary = this.fetchSummaryThread(discussions, input.run.runId);
      const markerThreads = this.fetchExistingFindingThreads(discussions, existingSummary?.noteId);
      markerThreads.forEach((value, key) => {
        findingsByMarker.set(key, value);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
    }

    const diffRefs = await this.fetchMergeRequestDiffRefs(input.repo, reviewNumber, input.credential.token).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
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
        result.providerThreadId = existingThread.noteId;
        result.providerThreadUrl = existingThread.noteUrl;
        this.updateFindingRecord(updatedFindings, finding.findingId, result.providerThreadId);
        results.push(result);
        continue;
      }

      if (!shouldInline || !finding.filePath || !finding.lineStart || !diffRefs) {
        needsSummary.push(finding);
        result.summary = true;
        result.reason = !shouldInline || !finding.filePath || !finding.lineStart
          ? 'Posting inline unavailable or disabled.'
          : 'Missing MR diff metadata required for inline posting.';
        results.push(result);
        continue;
      }

      try {
        const response = await this.postGitLabInlineFinding({
          repo: input.repo,
          reviewNumber,
          finding,
          marker,
          diffRefs,
          token: input.credential.token
        });
        result.posted = true;
        result.inline = true;
        result.summary = false;
        result.providerThreadId = response.noteId;
        result.providerThreadUrl = response.noteUrl;
        this.updateFindingRecord(updatedFindings, finding.findingId, result.providerThreadId);
      } catch (error) {
        needsSummary.push(finding);
        result.inline = false;
        result.summary = true;
        result.reason = `Inline posting failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      results.push(result);
    }

    let summary: ReviewPostingResult['summary'];
    if (needsSummary.length > 0) {
      try {
        const postedSummary = await this.postGitLabSummaryNote({
          repo: input.repo,
          reviewNumber,
          runId: input.run.runId,
          findings: needsSummary,
          token: input.credential.token,
          existingSummaryNoteId: existingSummary?.noteId
        });
        summary = {
          posted: true,
          providerThreadId: postedSummary.noteId,
          providerThreadUrl: postedSummary.noteUrl
        };
        needsSummary.forEach((finding) => {
          const record = results.find((entry) => entry.findingId === finding.findingId);
          if (record) {
            record.posted = true;
            record.inline = false;
            record.summary = true;
            record.providerThreadId = postedSummary.noteId;
            record.providerThreadUrl = postedSummary.noteUrl;
            record.reason = undefined;
          }
          this.updateFindingRecord(updatedFindings, finding.findingId, postedSummary.noteId);
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

    const discussions = await this.fetchDiscussions(input.repo, reviewNumber, input.credential.token);
    const targetIds = input.findingIds ? new Set(input.findingIds) : undefined;
    const normalized: ReviewReplyContext = {};

    for (const discussion of discussions) {
      const root = discussion.notes?.[0];
      const rootBody = root?.body;
      if (!rootBody) {
        continue;
      }

      const markerIds = extractFindingIdsFromText(rootBody);
      const summaryRunId = extractRunIdFromSummaryMarker(rootBody);
      const allowedIds = markerIds.length > 0
        ? markerIds
        : summaryRunId === input.run.runId
          ? extractFindingIdsFromText(rootBody)
          : [];

      if (!allowedIds.length) {
        continue;
      }

      for (const note of (discussion.notes ?? []).slice(1)) {
        const body = note.body;
        if (!body) {
          continue;
        }
        const explicitIds = extractFindingIdsFromText(body);
        const replyIds = explicitIds.length > 0 ? explicitIds : allowedIds;
        for (const findingId of replyIds) {
          if (targetIds && !targetIds.has(findingId)) {
            continue;
          }
          if (!normalized[findingId]) {
            normalized[findingId] = [];
          }
          normalized[findingId].push(body);
        }
      }
    }

    return normalized;
  }

  private async fetchMergeRequestDiffRefs(
    repo: Repo,
    reviewNumber: number,
    token: string
  ): Promise<NonNullable<GitLabMergeRequestResponse['diff_refs']>> {
    const payload = await this.requestJson<GitLabMergeRequestResponse>(
      repo,
      `/merge_requests/${reviewNumber}`,
      token
    );
    const diffRefs = payload.diff_refs;
    if (!diffRefs?.head_sha || !diffRefs.base_sha || !diffRefs.start_sha) {
      throw new Error('Merge request diff references are not available.');
    }
    return diffRefs;
  }

  private async postGitLabInlineFinding(input: GitLabPostingInput): Promise<{ noteId: string; noteUrl?: string }> {
    const line = input.finding.lineStart ?? 1;
    const response = await this.requestJson<GitLabDiscussionResponse>(
      input.repo,
      `/merge_requests/${input.reviewNumber}/discussions`,
      input.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: buildReviewFindingBody({ finding: input.finding, marker: input.marker, includeLocation: true }),
          position: {
            position_type: 'text',
            base_sha: input.diffRefs.base_sha,
            start_sha: input.diffRefs.start_sha,
            head_sha: input.diffRefs.head_sha,
            old_path: input.finding.filePath,
            new_path: input.finding.filePath,
            new_line: line
          }
        })
      }
    );

    const firstNote = response.notes?.[0];
    if (!firstNote?.id) {
      throw new Error('GitLab inline posting response did not contain a note id.');
    }
    return {
      noteId: String(firstNote.id),
      noteUrl: firstNote.url
    };
  }

  private async postGitLabSummaryNote(input: {
    repo: Repo;
    reviewNumber: number;
    runId: string;
    findings: ReviewFinding[];
    token: string;
    existingSummaryNoteId?: string;
  }): Promise<{ noteId: string; noteUrl?: string }> {
    const marker = buildReviewSummaryMarker(input.runId);
    const body = [
      marker,
      '# AgentsKanban Review Notes',
      '',
      'The following findings were posted in summary form because inline posting was not available:',
      ...input.findings.map((finding, index) => {
        const findingLine = buildReviewFindingBody({
          finding,
          marker: buildReviewFindingMarker(finding.findingId, input.runId),
          includeLocation: true
        });
        return `${index + 1}. ${findingLine}`;
      }),
      ''
    ].join('\n');

    if (input.existingSummaryNoteId) {
      const response = await this.requestJson<GitLabNoteResponse>(
        input.repo,
        `/merge_requests/${input.reviewNumber}/notes/${input.existingSummaryNoteId}`,
        input.token,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body })
        }
      );
      return {
        noteId: input.existingSummaryNoteId,
        noteUrl: response.url
      };
    }

    const response = await this.requestJson<GitLabDiscussionResponse>(
      input.repo,
      `/merge_requests/${input.reviewNumber}/discussions`,
      input.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      }
    );
    const firstNote = response.notes?.[0];
    if (!firstNote?.id) {
      throw new Error('GitLab summary posting response did not contain a note id.');
    }
    return {
      noteId: String(firstNote.id),
      noteUrl: firstNote.url
    };
  }

  private fetchExistingFindingThreads(
    discussions: GitLabDiscussion[],
    summaryNoteId?: string
  ): ExistingThreadMap {
    const map: ExistingThreadMap = new Map();

    for (const discussion of discussions) {
      const rootBody = discussion.notes?.[0]?.body;
      if (!rootBody) {
        continue;
      }
      const note = discussion.notes?.[0];
      if (!note?.id) {
        continue;
      }
      const noteId = String(note.id);
      const isSummary = summaryNoteId !== undefined && summaryNoteId === noteId;

      for (const findingId of extractFindingIdsFromText(rootBody)) {
        map.set(findingId, {
          noteId,
          noteUrl: note.url,
          isSummary
        });
      }
    }

    return map;
  }

  private fetchSummaryThread(
    discussions: GitLabDiscussion[],
    runId: string
  ): ExistingSummary | undefined {
    const summaryMarker = buildReviewSummaryMarker(runId);
    for (const discussion of discussions) {
      const root = discussion.notes?.[0];
      if (!root?.body?.includes(summaryMarker) || !root.id) {
        continue;
      }
      return {
        noteId: String(root.id),
        noteUrl: root.url
      };
    }
    return undefined;
  }

  private async fetchDiscussions(
    repo: Repo,
    reviewNumber: number,
    token: string
  ): Promise<GitLabDiscussion[]> {
    const response = await this.requestJson<GitLabDiscussion[]>(
      repo,
      `/merge_requests/${reviewNumber}/discussions?per_page=100`,
      token
    );
    return response;
  }

  private async requestJson<T>(repo: Repo, path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.buildApiUrl(repo, path), {
      ...init,
      headers: {
        Accept: 'application/json',
        'PRIVATE-TOKEN': token,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      throw new Error(`GitLab review-posting request failed with status ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }

  private buildApiUrl(repo: Repo, path: string) {
    return `${buildGitlabApiBaseUrl(repo)}/projects/${encodeURIComponent(getRepoProjectPath(repo))}${path}`;
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
