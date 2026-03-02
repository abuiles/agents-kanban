import { describe, expect, it } from 'vitest';
import { buildWorkflowInvocationId } from './workflow-id';
import { getCodexCapacityDecision } from './codex-rate-limit';
import { shouldRunEvidence, shouldRunPreview } from './shared/repo-execution-policy';

describe('buildWorkflowInvocationId', () => {
  it('includes a time suffix so retries for the same run get a fresh workflow id', () => {
    const params = {
      repoId: 'repo_demo',
      taskId: 'task_demo',
      runId: 'run_demo',
      mode: 'preview_only' as const
    };

    const first = buildWorkflowInvocationId(params, new Date('2026-03-02T03:00:01.000Z'));
    const second = buildWorkflowInvocationId(params, new Date('2026-03-02T03:00:02.000Z'));

    expect(first).toBe('preview-only-run_demo-20260302030001');
    expect(second).toBe('preview-only-run_demo-20260302030002');
    expect(second).not.toBe(first);
  });
});

describe('getCodexCapacityDecision', () => {
  it('waits when the selected model has less than 1% left', () => {
    const nowMs = Date.UTC(2026, 2, 2, 4, 0, 0);
    const payload = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 99.2, resetsAt: Math.floor((nowMs + 10 * 60_000) / 1000) },
        secondary: { usedPercent: 20, resetsAt: Math.floor((nowMs + 7 * 24 * 60 * 60_000) / 1000) }
      },
      rateLimitsByLimitId: null
    };

    const decision = getCodexCapacityDecision(payload, 'gpt-5.1-codex-mini', nowMs);
    expect(decision.shouldWait).toBe(true);
    expect(decision.waitMs).toBeGreaterThan(0);
  });

  it('selects the spark bucket for gpt-5.3-codex-spark', () => {
    const nowMs = Date.UTC(2026, 2, 2, 4, 0, 0);
    const payload = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 10, resetsAt: Math.floor((nowMs + 10 * 60_000) / 1000) }
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 10, resetsAt: Math.floor((nowMs + 10 * 60_000) / 1000) }
        },
        codex_bengalfox: {
          limitId: 'codex_bengalfox',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 100, resetsAt: Math.floor((nowMs + 30 * 60_000) / 1000) }
        }
      }
    };

    const decision = getCodexCapacityDecision(payload, 'gpt-5.3-codex-spark', nowMs);
    expect(decision.shouldWait).toBe(true);
    expect(decision.snapshot?.limitId).toBe('codex_bengalfox');
  });

  it('does not wait when budget is above 1%', () => {
    const nowMs = Date.UTC(2026, 2, 2, 4, 0, 0);
    const payload = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 97, resetsAt: Math.floor((nowMs + 10 * 60_000) / 1000) },
        secondary: { usedPercent: 50, resetsAt: Math.floor((nowMs + 7 * 24 * 60 * 60_000) / 1000) }
      }
    };

    const decision = getCodexCapacityDecision(payload, 'gpt-5.3-codex', nowMs);
    expect(decision.shouldWait).toBe(false);
  });
});

describe('repo execution policies', () => {
  it('runs preview and evidence by default', () => {
    const repo = {
      repoId: 'repo_demo',
      slug: 'acme/demo',
      defaultBranch: 'main',
      baselineUrl: 'https://example.com',
      enabled: true,
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z'
    };

    expect(shouldRunPreview(repo)).toBe(true);
    expect(shouldRunEvidence(repo)).toBe(true);
  });

  it('skips preview and evidence when explicitly disabled', () => {
    const repo = {
      repoId: 'repo_demo',
      slug: 'acme/demo',
      defaultBranch: 'main',
      baselineUrl: 'https://example.com',
      enabled: true,
      previewMode: 'skip' as const,
      evidenceMode: 'skip' as const,
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z'
    };

    expect(shouldRunPreview(repo)).toBe(false);
    expect(shouldRunEvidence(repo)).toBe(false);
  });
});
