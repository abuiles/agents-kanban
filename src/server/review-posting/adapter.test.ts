import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, Repo, Task, ReviewFinding } from '../../ui/domain/types';
import {
  buildReviewFindingMarker,
  buildReviewSummaryMarker,
  retryReviewPosting
} from './adapter';
import { GitLabReviewPostingAdapter } from './gitlab';
import { JiraReviewPostingAdapter } from './jira';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_demo',
    slug: 'group/platform/demo',
    scmProvider: 'gitlab',
    scmBaseUrl: 'https://gitlab.example.com',
    projectPath: 'group/platform/demo',
    defaultBranch: 'main',
    baselineUrl: 'https://example.com',
    enabled: true,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task_demo',
    repoId: 'repo_demo',
    title: 'Update demo flow',
    taskPrompt: 'Do the thing',
    acceptanceCriteria: ['it works'],
    context: { links: [] },
    status: 'ACTIVE',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  };
}

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run_demo',
    taskId: 'task_demo',
    repoId: 'repo_demo',
    status: 'PR_OPEN',
    branchName: 'agent/run-demo',
    previewStatus: 'UNKNOWN',
    evidenceStatus: 'NOT_STARTED',
    errors: [],
    startedAt: '2026-03-02T00:00:00.000Z',
    simulationProfile: 'happy_path',
    timeline: [],
    pendingEvents: [],
    ...overrides
  };
}

function buildFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    findingId: 'rf_1a2b3c4d',
    severity: 'high',
    title: 'Potential SQL injection',
    description: 'Use prepared statements.',
    status: 'open',
    filePath: 'src/db.ts',
    lineStart: 42,
    lineEnd: 44,
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('retryReviewPosting', () => {
  it('retries failed operations before succeeding', async () => {
    const attempts = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('ok');

    const result = await retryReviewPosting<string>({
      operation: attempts,
      maxAttempts: 2
    }, 'temporary retry coverage');

    expect(result).toBe('ok');
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retry attempts', async () => {
    const attempts = vi.fn().mockRejectedValue(new Error('hard failure'));

    const promise = retryReviewPosting<string>({
      operation: attempts,
      maxAttempts: 2
    }, 'exhaustion coverage');

    await expect(promise).rejects.toThrow('exhaustion coverage');
    expect(attempts).toHaveBeenCalledTimes(2);
  });
});

describe('GitLab review posting adapter', () => {
  it('posts inline findings when location is available and reuses existing notes by marker', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{
          id: 'd1',
          notes: [{ id: '100', body: 'ignore me' }]
        }]), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' }
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          {
            id: 'd2',
            notes: [{ id: '101', body: 'ignore me' }]
          }
        ]), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          id: 900,
          notes: [{ id: '200', body: 'inline marker', url: 'https://gitlab.example.com/note/200' }]
        }), { status: 201 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          {
            id: 'd3',
            notes: [{ id: '102', body: 'ignore me' }]
          }
        ]), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          id: 901,
          notes: [{ id: '201', body: 'inline marker', url: 'https://gitlab.example.com/note/201' }]
        }), { status: 201 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GitLabReviewPostingAdapter();
    const result = await adapter.postFindings({
      repo: buildRepo(),
      task: buildTask(),
      run: buildRun({ reviewNumber: 123 }),
      findings: [
        buildFinding({ findingId: 'rf_1', lineStart: 42, lineEnd: 44 }),
        buildFinding({ findingId: 'rf_2', lineStart: 7 })
      ],
      credential: { token: 'glpat_test' },
      postInline: true
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((entry) => entry.posted && entry.inline)).toBe(true);
    expect(result.summary).toBeUndefined();
    expect(result.findings[0].providerThreadId).toBe('200');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('falls back to a summary note when inline posting is unavailable', async () => {
    const finding = buildFinding({
      findingId: 'rf_1',
      filePath: 'src/main.ts',
      lineStart: 12
    });
    const marker = buildReviewFindingMarker(finding.findingId, 'run_demo');
    const summaryMarker = buildReviewSummaryMarker('run_demo');

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' }
        }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response('bad request', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 1000,
        notes: [{ id: '3000', body: `summary body includes ${marker} and ${summaryMarker}`, url: 'https://gitlab.example.com/note/3000' }]
      }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GitLabReviewPostingAdapter();
    const result = await adapter.postFindings({
      repo: buildRepo(),
      task: buildTask(),
      run: buildRun({ reviewNumber: 123 }),
      findings: [finding],
      credential: { token: 'glpat_test' },
      postInline: true
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].inline).toBe(false);
    expect(result.findings[0].summary).toBe(true);
    expect(result.findings[0].posted).toBe(true);
    expect(result.findings[0].providerThreadId).toBe('3000');
    expect(result.summary?.providerThreadId).toBe('3000');
    expect(result.summary?.posted).toBe(true);
  });

  it('maps GitLab discussion replies back to finding IDs', async () => {
    const findingA = buildFinding({ findingId: 'rf_a1', filePath: 'src/a.ts', lineStart: 11 });
    const findingB = buildFinding({ findingId: 'rf_b2', filePath: 'src/b.ts', lineStart: 3 });
    const markerA = buildReviewFindingMarker(findingA.findingId, 'run_demo');
    const markerB = buildReviewFindingMarker(findingB.findingId, 'run_demo');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      {
        id: 1,
        notes: [
          { id: 10, body: `Finding note ${markerA} with details` },
          { id: 11, body: 'Please review this before merge.' }
        ]
      },
      {
        id: 2,
        notes: [
          { id: 20, body: `Finding note ${markerB} with details` },
          { id: 21, body: `${markerB} additional note` },
          { id: 22, body: 'No marker reply for finding b.' }
        ]
      }
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GitLabReviewPostingAdapter();
    const context = await adapter.fetchReplyContext({
      repo: buildRepo(),
      task: buildTask(),
      run: buildRun({ reviewNumber: 123 }),
      findingIds: [findingA.findingId, findingB.findingId],
      credential: { token: 'glpat_test' }
    });

    expect(context[findingA.findingId]).toEqual(['Please review this before merge.']);
    expect(context[findingB.findingId]).toEqual([`${markerB} additional note`, 'No marker reply for finding b.']);
  });
});

describe('Jira review posting adapter', () => {
  it('posts Jira comments with stable finding markers and location references', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '9001' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '9002' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new JiraReviewPostingAdapter();
    const result = await adapter.postFindings({
      repo: buildRepo({ scmProvider: 'github', scmBaseUrl: 'https://github.com', projectPath: 'acme/demo', autoReview: undefined }),
      task: buildTask(),
      run: buildRun({ reviewUrl: 'https://jira.example.com/browse/ABC-123' }),
      findings: [
        buildFinding({ findingId: 'rf_1', filePath: 'src/main.ts', lineStart: 10 }),
        buildFinding({ findingId: 'rf_2', filePath: 'src/lib.ts', lineStart: 30, lineEnd: 35 })
      ],
      credential: { token: 'jira_token' }
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((entry) => entry.posted)).toBe(true);
    expect(result.findings[0].providerThreadId).toBe('9001');
    expect(result.findings[1].providerThreadId).toBe('9002');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/rest/api/2/issue/ABC-123/comment');
    const secondBody = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string).body;
    expect(secondBody).toContain('Location: src/main.ts:10');
  });

  it('reuses existing Jira marker mapping for idempotent retry-safe posting', async () => {
    const markerA = buildReviewFindingMarker('rf_1', 'run_demo');
    const markerB = buildReviewFindingMarker('rf_2', 'run_demo');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        comments: [
          { id: '101', body: markerA },
          { id: '102', body: markerB }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ comments: [{ id: '101', body: markerA }] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ comments: [{ id: '102', body: markerB }] }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new JiraReviewPostingAdapter();
    const result = await adapter.postFindings({
      repo: buildRepo({ scmProvider: 'github', scmBaseUrl: 'https://github.com', projectPath: 'acme/demo', autoReview: undefined }),
      task: buildTask(),
      run: buildRun({ reviewUrl: 'https://jira.example.com/browse/ABC-123' }),
      findings: [
        buildFinding({ findingId: 'rf_1', filePath: 'src/main.ts', lineStart: 10 }),
        buildFinding({ findingId: 'rf_2', filePath: 'src/lib.ts', lineStart: 30, lineEnd: 35 })
      ],
      credential: { token: 'jira_token' }
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((entry) => entry.posted)).toBe(true);
    expect(result.findings[0].providerThreadId).toBe('101');
    expect(result.findings[1].providerThreadId).toBe('102');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers to existing Jira marker during retry without posting duplicates', async () => {
    const markerA = buildReviewFindingMarker('rf_1', 'run_demo');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ comments: [{ id: '901', body: markerA }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new JiraReviewPostingAdapter();
    const result = await adapter.postFindings({
      repo: buildRepo({ scmProvider: 'github', scmBaseUrl: 'https://github.com', projectPath: 'acme/demo', autoReview: undefined }),
      task: buildTask(),
      run: buildRun({ reviewUrl: 'https://jira.example.com/browse/ABC-123' }),
      findings: [buildFinding({ findingId: 'rf_1', filePath: 'src/main.ts', lineStart: 10 })],
      credential: { token: 'jira_token' }
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ posted: true, providerThreadId: '901' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const postPath = fetchMock.mock.calls[2]?.[0];
    expect(typeof postPath).toBe('string');
    expect(postPath as string).toContain('/rest/api/2/issue/ABC-123/comment');
  });

  it('maps Jira replies back to finding IDs from marker-bearing comments', async () => {
    const markerA = buildReviewFindingMarker('rf_1', 'run_demo');
    const markerB = buildReviewFindingMarker('rf_2', 'run_demo');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      comments: [
        { id: '1', body: `${markerA} Finding A` },
        { id: '2', body: `${markerA} LGTM` },
        { id: '3', body: `${markerB} needs follow up` }
      ]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new JiraReviewPostingAdapter();
    const context = await adapter.fetchReplyContext({
      repo: buildRepo({ scmProvider: 'github', scmBaseUrl: 'https://github.com', projectPath: 'acme/demo' }),
      task: buildTask(),
      run: buildRun({
        reviewUrl: 'https://jira.example.com/browse/ABC-123'
      }),
      findingIds: ['rf_1', 'rf_2'],
      credential: { token: 'jira_token' }
    });

    expect(context.rf_1).toEqual([`${markerA} LGTM`]);
    expect(context.rf_2).toBeUndefined();
  });
});
