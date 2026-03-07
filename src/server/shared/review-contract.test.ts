import { describe, expect, it } from 'vitest';
import type { Repo, Task } from '../../ui/domain/types';
import {
  REVIEW_FINDINGS_OUTPUT_SCHEMA,
  attachReviewArtifactsToManifest,
  buildReviewArtifactPointers,
  buildReviewFindingsJsonArtifact,
  buildReviewFindingsMarkdownArtifact,
  buildRunReviewArtifacts,
  parseReviewFindings,
  resolveAutoReviewConfig
} from './review-contract';

function buildRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo_demo',
    slug: 'acme/demo',
    defaultBranch: 'main',
    baselineUrl: 'https://example.com',
    enabled: true,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  } as Repo;
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task_demo',
    repoId: 'repo_demo',
    title: 'Task',
    taskPrompt: 'prompt',
    acceptanceCriteria: ['done'],
    context: { links: [] },
    status: 'INBOX',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    ...overrides
  } as Task;
}

describe('resolveAutoReviewConfig', () => {
  it('lets task-level "on" override a disabled repo setting', () => {
    const result = resolveAutoReviewConfig(
      buildRepo({ autoReview: { enabled: false, provider: 'gitlab', postInline: false } }),
      buildTask({ uiMeta: { autoReviewMode: 'on', autoReviewPrompt: 'Task override prompt' } })
    );

    expect(result.enabled).toBe(true);
    expect(result.promptSource).toBe('task');
    expect(result.prompt).toBe('Task override prompt');
  });

  it('lets task-level "off" disable an enabled repo setting', () => {
    const result = resolveAutoReviewConfig(
      buildRepo({ autoReview: { enabled: true, provider: 'gitlab', postInline: true, prompt: 'Repo prompt' } }),
      buildTask({ uiMeta: { autoReviewMode: 'off' } })
    );

    expect(result.enabled).toBe(false);
    expect(result.promptSource).toBe('native');
    expect(result.prompt).toBeUndefined();
    expect(result.postInline).toBe(true);
  });

  it('uses repo prompt only when task mode inherits', () => {
    const result = resolveAutoReviewConfig(
      buildRepo({ autoReview: { enabled: true, provider: 'jira', postInline: true, prompt: 'Repo prompt' } }),
      buildTask({ uiMeta: { autoReviewMode: 'inherit' } })
    );

    expect(result.enabled).toBe(true);
    expect(result.promptSource).toBe('repo');
    expect(result.prompt).toBe('Repo prompt');
    expect(result.provider).toBe('jira');
  });

  it('falls back to native mode when neither task nor repo prompt exists', () => {
    const result = resolveAutoReviewConfig(
      buildRepo({ autoReview: { enabled: true, provider: 'gitlab', postInline: false } }),
      buildTask({ uiMeta: { autoReviewMode: 'inherit' } })
    );

    expect(result.enabled).toBe(true);
    expect(result.promptSource).toBe('native');
    expect(result.prompt).toBeUndefined();
  });

  it('uses enabled playbook prompts when repo selects a playbook and task inherits', () => {
    const result = resolveAutoReviewConfig(
      buildRepo({
        autoReview: {
          enabled: true,
          provider: 'gitlab',
          postInline: false,
          playbookId: 'playbook_security'
        }
      }),
      buildTask({ uiMeta: { autoReviewMode: 'inherit' } }),
      [{
        playbookId: 'playbook_security',
        tenantId: 'tenant_default',
        name: 'Security',
        prompt: 'Use security checklist.',
        enabled: true,
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z'
      }]
    );

    expect(result.enabled).toBe(true);
    expect(result.promptSource).toBe('playbook');
    expect(result.prompt).toBe('Use security checklist.');
  });

  it('falls back to native prompt mode when selected playbook is missing or disabled', () => {
    const missing = resolveAutoReviewConfig(
      buildRepo({
        autoReview: {
          enabled: true,
          provider: 'gitlab',
          postInline: false,
          playbookId: 'playbook_missing'
        }
      }),
      buildTask({ uiMeta: { autoReviewMode: 'inherit' } }),
      []
    );
    const disabled = resolveAutoReviewConfig(
      buildRepo({
        autoReview: {
          enabled: true,
          provider: 'gitlab',
          postInline: false,
          playbookId: 'playbook_disabled'
        }
      }),
      buildTask({ uiMeta: { autoReviewMode: 'inherit' } }),
      [{
        playbookId: 'playbook_disabled',
        tenantId: 'tenant_default',
        name: 'Disabled',
        prompt: 'Should not run.',
        enabled: false,
        createdAt: '2026-03-02T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z'
      }]
    );

    expect(missing.promptSource).toBe('native');
    expect(missing.prompt).toBeUndefined();
    expect(disabled.promptSource).toBe('native');
    expect(disabled.prompt).toBeUndefined();
  });

  it('includes repo-level review llm settings in resolved config', () => {
    const result = resolveAutoReviewConfig(
      buildRepo({
        autoReview: {
          enabled: true,
          provider: 'github',
          postInline: true,
          llmAdapter: 'codex',
          llmModel: 'gpt-5.3-codex-spark',
          llmReasoningEffort: 'high',
          codexModel: 'gpt-5.3-codex-spark',
          codexReasoningEffort: 'high'
        }
      }),
      buildTask({ uiMeta: { autoReviewMode: 'inherit' } })
    );

    expect(result.llmAdapter).toBe('codex');
    expect(result.llmModel).toBe('gpt-5.3-codex-spark');
    expect(result.llmReasoningEffort).toBe('high');
    expect(result.codexModel).toBe('gpt-5.3-codex-spark');
    expect(result.codexReasoningEffort).toBe('high');
  });
});

describe('parseReviewFindings', () => {
  it('validates and normalizes review findings with stable IDs', () => {
    const payload = {
      findings: [
        {
          severity: 'high',
          title: 'Potential SQL injection',
          description: 'Parameter should be escaped before query execution.',
          status: 'open',
          filePath: 'src/db.ts',
          lineStart: 42,
          lineEnd: 44
        },
        {
          severity: 'high',
          title: 'Potential SQL injection',
          description: 'Parameter should be escaped before query execution.',
          status: 'open',
          filePath: 'src/db.ts',
          lineStart: 42,
          lineEnd: 44
        }
      ]
    };

    const first = parseReviewFindings(payload);
    const second = parseReviewFindings(JSON.stringify(payload));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const firstFindings = first.ok ? first.findings : [];
    const secondFindings = second.ok ? second.findings : [];
    expect(firstFindings).toHaveLength(2);
    expect(firstFindings[0].findingId).toMatch(/^rf_[0-9a-f]{8}$/);
    expect(firstFindings[1].findingId).toMatch(/^rf_[0-9a-f]{8}-2$/);
    expect(firstFindings[0].findingId).toBe(secondFindings[0].findingId);
    expect(firstFindings[1].findingId).toBe(secondFindings[1].findingId);
    expect(firstFindings[0].status).toBe('open');
    expect(firstFindings[0].severity).toBe('high');
  });

  it('returns a structured failure for malformed JSON payloads', () => {
    const parsed = parseReviewFindings('{ findings: [] }');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe('REVIEW_FINDINGS_INVALID_JSON');
    }
  });

  it('returns a schema error for invalid finding entries', () => {
    const parsed = parseReviewFindings({
      findings: [
        {
          severity: 'critical',
          title: '',
          description: 'Missing title body.'
        }
      ]
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe('REVIEW_FINDINGS_VALIDATION_ERROR');
    }
  });
});

describe('review artifact metadata contract', () => {
  it('builds deterministic review artifact pointers under tenant run paths', () => {
    expect(buildReviewArtifactPointers({ tenantId: 'tenant_demo', runId: 'run_demo' })).toMatchObject({
      findingsJson: {
        key: 'tenants/tenant_demo/runs/run_demo/review/findings.json',
        label: 'Review findings JSON'
      },
      reviewMarkdown: {
        key: 'tenants/tenant_demo/runs/run_demo/review/review-findings.md',
        label: 'Review markdown'
      }
    });
  });

  it('writes review pointers into manifest metadata', () => {
    const manifest = attachReviewArtifactsToManifest(
      {
        logs: { key: 'runs/run_demo/logs.txt', label: 'Logs' },
        metadata: { generatedAt: '2026-03-02T00:00:00.000Z', environmentId: 'env_demo' }
      },
      { tenantId: 'tenant_demo', runId: 'run_demo' }
    );

    expect(manifest.reviewFindingsJson?.key).toContain('run_demo/review/findings.json');
    expect(manifest.reviewMarkdown?.key).toContain('run_demo/review/review-findings.md');
  });

  it('builds stable review artifact metadata keys', () => {
    expect(buildRunReviewArtifacts({ tenantId: 'tenant_demo', runId: 'run_demo' })).toMatchObject({
      findingsJsonKey: 'tenants/tenant_demo/runs/run_demo/review/findings.json',
      reviewMarkdownKey: 'tenants/tenant_demo/runs/run_demo/review/review-findings.md'
    });
  });

  it('renders deterministic review payload formats', () => {
    const parsed = parseReviewFindings({
      findings: [
        {
          severity: 'info',
          title: 'Minor style warning',
          description: 'Use const for this variable.',
          status: 'addressed'
        }
      ]
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const findingsJson = buildReviewFindingsJsonArtifact(parsed.findings);
    const findingsMarkdown = buildReviewFindingsMarkdownArtifact(parsed.findings);

    expect(findingsJson).toContain('"findings"');
    expect(findingsMarkdown).toContain('# Review Findings');
    expect(findingsMarkdown).toContain('Finding 1');
  });

  it('exposes a strict output schema for the review step', () => {
    expect(REVIEW_FINDINGS_OUTPUT_SCHEMA.required).toContain('findings');
    expect(REVIEW_FINDINGS_OUTPUT_SCHEMA.properties.findings).toBeTruthy();
  });
});
