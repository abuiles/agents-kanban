import type { AutoReviewProvider, AgentRun, ReviewFinding, Task } from '../../ui/domain/types';
import {
  ReviewPostingAdapter,
  type ReviewPostingFindingRecord,
  type ReviewPostingInput,
  type ReviewPostingResult,
  type ReviewReplyContext,
  type ReviewReplyFetchInput,
  buildReviewFindingBody,
  buildReviewFindingMarker,
  extractFindingIdsFromText
} from './adapter';

type JiraIssueComment = {
  id?: string;
  body?: unknown;
};

type JiraIssueCommentResponse = {
  id: string;
  comments?: JiraIssueComment[];
};

type JiraIssueLookup = {
  issueKey: string;
  host: string;
};

type JiraCommentRequestPayload = {
  body: string;
};

type JiraCommentResponse = {
  id: string;
};

const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export class JiraReviewPostingAdapter implements ReviewPostingAdapter {
  readonly provider: AutoReviewProvider = 'jira';

  async postFindings(input: ReviewPostingInput): Promise<ReviewPostingResult> {
    const target = this.resolveJiraIssue(input.run, input.task);
    if (!target) {
      const message = 'Unable to resolve Jira issue key for this run.';
      return {
        provider: this.provider,
        findings: input.findings.map((finding) => ({
          findingId: finding.findingId,
          posted: false,
          inline: false,
          summary: false,
          reason: message
        })),
        updatedFindings: [...input.findings],
        errors: [message]
      };
    }

    const existingComments = await this.fetchExistingComments(target.host, target.issueKey, input.credential.token);
    const existingMap = new Map<string, string>();
    for (const comment of existingComments) {
      const existingMarkerIds = extractFindingIdsFromText(this.toJiraBodyText(comment.body));
      const commentId = comment.id;
      if (!commentId) {
        continue;
      }
      for (const findingId of existingMarkerIds) {
        existingMap.set(findingId, commentId);
      }
    }

    const results: ReviewPostingFindingRecord[] = [];
    const updatedFindings = [...input.findings];
    const errors: string[] = [];

    for (const finding of input.findings) {
      const record: ReviewPostingFindingRecord = {
        findingId: finding.findingId,
        posted: false,
        inline: false,
        summary: false
      };
      const marker = buildReviewFindingMarker(finding.findingId, input.run.runId);
      const existingCommentId = existingMap.get(finding.findingId);
      if (existingCommentId) {
        record.posted = true;
        record.providerThreadId = existingCommentId;
        this.updateFindingRecord(updatedFindings, finding.findingId, existingCommentId);
        results.push(record);
        continue;
      }

      const body = this.buildJiraCommentBody({
        finding,
        marker,
        includeLocation: Boolean(finding.filePath)
      });
      try {
        const response = await this.requestJson<JiraCommentResponse>(
          target.host,
          `/rest/api/2/issue/${encodeURIComponent(target.issueKey)}/comment`,
          input.credential.token,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body } satisfies JiraCommentRequestPayload)
          }
        );
        if (response.id) {
          record.posted = true;
          record.providerThreadId = response.id;
          record.providerThreadUrl = `${target.host}/browse/${target.issueKey}?focusedCommentId=${response.id}&page=com.atlassian.jira.plugin.system.issuetabpanels:comment-tabpanel#comment-${response.id}`;
          this.updateFindingRecord(updatedFindings, finding.findingId, record.providerThreadId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record.reason = message;
        errors.push(message);
      }
      results.push(record);
    }

    return {
      provider: this.provider,
      findings: results,
      updatedFindings,
      errors
    };
  }

  async fetchReplyContext(input: ReviewReplyFetchInput): Promise<ReviewReplyContext> {
    const target = this.resolveJiraIssue(input.run, input.task);
    if (!target) {
      return {};
    }

    const response = await this.requestJson<JiraIssueCommentResponse>(
      target.host,
      `/rest/api/2/issue/${encodeURIComponent(target.issueKey)}/comment`,
      input.credential.token
    );
    const comments = response.comments ?? [];
    const targetIds = input.findingIds ? new Set(input.findingIds) : undefined;

    const firstByFinding = new Map<string, number>();
    const replies: ReviewReplyContext = {};

    comments.forEach((comment, index) => {
      const commentBody = this.toJiraBodyText(comment.body);
      const markerIds = extractFindingIdsFromText(commentBody);
      if (!markerIds.length) {
        return;
      }
      for (const findingId of markerIds) {
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
          if (commentBody) {
            replies[findingId].push(commentBody);
          }
        }
      }
    });

    return replies;
  }

  private buildJiraCommentBody({
    finding,
    marker,
    includeLocation
  }: {
    finding: ReviewFinding;
    marker: string;
    includeLocation: boolean;
  }) {
    return `${marker}\n*${finding.title}*\n\n${finding.description}${includeLocation ? this.formatJiraFindingLocation(finding) : ''}`;
  }

  private formatJiraFindingLocation(finding: ReviewFinding) {
    if (!finding.filePath) {
      return '';
    }

    const lineStart = finding.lineStart;
    const lineEnd = finding.lineEnd;
    if (lineStart && lineEnd && lineStart !== lineEnd) {
      return `\nLocation: ${finding.filePath}:${lineStart}-${lineEnd}`;
    }
    if (lineStart) {
      return `\nLocation: ${finding.filePath}:${lineStart}`;
    }
    if (lineEnd) {
      return `\nLocation: ${finding.filePath}:${lineEnd}`;
    }
    return `\nLocation: ${finding.filePath}`;
  }

  private async fetchExistingComments(
    host: string,
    issueKey: string,
    token: string
  ): Promise<JiraIssueComment[]> {
    const response = await this.requestJson<JiraIssueCommentResponse>(
      host,
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      token
    );
    return response.comments ?? [];
  }

  private async requestJson<T>(host: string, path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${host}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      throw new Error(`Jira review-posting request failed with status ${response.status}.`);
    }
    return response.json() as Promise<T>;
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

  private toJiraBodyText(body: unknown): string {
    if (typeof body === 'string') {
      return body;
    }

    if (body && typeof body === 'object') {
      if ('text' in body && typeof body.text === 'string') {
        return body.text;
      }
      if ('body' in body && typeof body.body === 'string') {
        return body.body;
      }
      if ('content' in body && typeof body.content === 'string') {
        return body.content;
      }
    }
    return '';
  }

  private resolveJiraIssue(run: AgentRun, task: Task): JiraIssueLookup | undefined {
    for (const candidate of [run.reviewUrl, task.sourceRef]) {
      if (!candidate) {
        continue;
      }
      const parsed = this.parseJiraIssue(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  private parseJiraIssue(candidate: string): JiraIssueLookup | undefined {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return undefined;
    }

    const pathKey = url.pathname
      .split('/')
      .map((segment) => segment.trim())
      .find((segment) => JIRA_ISSUE_KEY_RE.test(segment.toUpperCase()));
    if (pathKey) {
      return {
        issueKey: pathKey.toUpperCase(),
        host: `${url.protocol}://${url.host}`
      };
    }

    const queryKey = url.searchParams.get('id') ?? url.searchParams.get('issueKey') ?? url.searchParams.get('selectedIssue');
    if (queryKey) {
      const match = queryKey.trim().toUpperCase().match(JIRA_ISSUE_KEY_RE);
      if (match) {
        return { issueKey: match[0], host: `${url.protocol}://${url.host}` };
      }
    }
    return undefined;
  }
}
