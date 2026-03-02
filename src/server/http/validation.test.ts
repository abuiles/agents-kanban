import { describe, expect, it } from 'vitest';
import { parseCreateRepoInput, parseCreateTaskInput, parseUpdateRepoInput, parseUpdateTaskInput, parseUpsertScmCredentialInput } from './validation';

function createTaskPayload(overrides: Record<string, unknown> = {}) {
  return {
    repoId: 'repo_demo',
    title: 'Task title',
    taskPrompt: 'Do work',
    acceptanceCriteria: ['Criterion 1'],
    context: {
      links: [{ id: 'link_1', label: 'Stage doc', url: 'https://example.com' }]
    },
    ...overrides
  };
}

describe('task validation', () => {
  it('parses create payload with dependency fields', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        dependencies: [{ upstreamTaskId: 'task_upstream', mode: 'review_ready', primary: true }],
        dependencyState: {
          blocked: false,
          unblockedAt: '2026-03-02T01:05:00.000Z',
          reasons: [{ upstreamTaskId: 'task_upstream', state: 'ready', message: 'Upstream task is in review.' }]
        },
        automationState: {
          autoStartEligible: true,
          autoStartedAt: '2026-03-02T00:00:00.000Z',
          lastDependencyRefreshAt: '2026-03-02T01:00:00.000Z'
        },
        branchSource: {
          kind: 'dependency_review_head',
          upstreamTaskId: 'task_upstream',
          upstreamRunId: 'run_upstream',
          upstreamReviewUrl: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
          upstreamReviewNumber: 42,
          upstreamReviewProvider: 'gitlab',
          upstreamPrNumber: 42,
          upstreamHeadSha: 'abc123',
          resolvedRef: 'refs/heads/agent/task_upstream/run_upstream',
          resolvedAt: '2026-03-02T00:05:00.000Z'
        }
      })
    );

    expect(parsed.dependencies).toEqual([{ upstreamTaskId: 'task_upstream', mode: 'review_ready', primary: true }]);
    expect(parsed.dependencyState?.blocked).toBe(false);
    expect(parsed.dependencyState?.reasons[0]?.state).toBe('ready');
    expect(parsed.automationState?.autoStartEligible).toBe(true);
    expect(parsed.branchSource?.kind).toBe('dependency_review_head');
    expect(parsed.branchSource?.upstreamReviewProvider).toBe('gitlab');
  });

  it('rejects create payload with multiple primary dependencies', () => {
    expect(() =>
      parseCreateTaskInput(
        createTaskPayload({
          dependencies: [
            { upstreamTaskId: 'task_a', mode: 'review_ready', primary: true },
            { upstreamTaskId: 'task_b', mode: 'review_ready', primary: true }
          ]
        })
      )
    ).toThrow('Invalid dependencies: only one primary dependency is allowed.');
  });

  it('rejects update payload with invalid dependency mode', () => {
    expect(() =>
      parseUpdateTaskInput({
        dependencies: [{ upstreamTaskId: 'task_a', mode: 'done_ready' }]
      })
    ).toThrow('Invalid dependencies[0].mode.');
  });

  it('rejects update payload with invalid automationState shape', () => {
    expect(() =>
      parseUpdateTaskInput({
        automationState: { autoStartEligible: 'yes' }
      })
    ).toThrow('Invalid automationState.autoStartEligible.');
  });

  it('rejects update payload with invalid dependencyState shape', () => {
    expect(() =>
      parseUpdateTaskInput({
        dependencyState: { blocked: 'yes', reasons: [] }
      })
    ).toThrow('Invalid dependencyState.blocked.');
  });

  it('rejects update payload with invalid branchSource fields', () => {
    expect(() =>
      parseUpdateTaskInput({
        branchSource: {
          kind: 'dependency_review_head',
          upstreamReviewNumber: 0,
          resolvedRef: 'refs/heads/demo',
          resolvedAt: '2026-03-02T00:00:00.000Z'
        }
      })
    ).toThrow('Invalid branchSource.upstreamReviewNumber.');
  });

  it('accepts provider-neutral llm task fields', () => {
    const parsed = parseCreateTaskInput(
      createTaskPayload({
        llmAdapter: 'cursor_cli',
        llmModel: 'cursor-fast',
        llmReasoningEffort: 'high'
      })
    );

    expect(parsed).toMatchObject({
      llmAdapter: 'cursor_cli',
      llmModel: 'cursor-fast',
      llmReasoningEffort: 'high',
      codexModel: undefined,
      codexReasoningEffort: undefined
    });
  });

  it('maps legacy codex task fields to provider-neutral llm fields', () => {
    const parsed = parseUpdateTaskInput({
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });

    expect(parsed).toMatchObject({
      llmModel: 'gpt-5.3-codex-spark',
      llmReasoningEffort: 'high',
      codexModel: 'gpt-5.3-codex-spark',
      codexReasoningEffort: 'high'
    });
  });
});

describe('repo validation', () => {
  it('parses preview and evidence execution policy fields', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://example.com',
      previewMode: 'skip',
      evidenceMode: 'skip',
      previewProvider: 'cloudflare'
    });

    expect(parsed.previewMode).toBe('skip');
    expect(parsed.evidenceMode).toBe('skip');
    expect(parsed.previewProvider).toBe('cloudflare');
  });

  it('rejects invalid repo execution policy values', () => {
    expect(() =>
      parseUpdateRepoInput({
        previewMode: 'sometimes'
      })
    ).toThrow('Invalid previewMode.');
  });

  it('parses provider-neutral repo payloads and keeps slug compatibility', () => {
    const parsed = parseCreateRepoInput({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/platform/repo',
      baselineUrl: 'https://repo.example.com'
    });

    expect(parsed).toMatchObject({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com',
      projectPath: 'group/platform/repo',
      slug: 'group/platform/repo'
    });
  });

  it('accepts legacy GitHub slug-only payloads', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://minions.example.com'
    });

    expect(parsed.slug).toBe('abuiles/minions');
    expect(parsed.projectPath).toBe('abuiles/minions');
    expect(parsed.scmProvider).toBeUndefined();
  });

  it('rejects mismatched slug and projectPath values', () => {
    expect(() =>
      parseUpdateRepoInput({
        slug: 'acme/one',
        projectPath: 'acme/two'
      })
    ).toThrow('Invalid repo patch payload: slug and projectPath must match when both are provided.');
  });

  it('mirrors legacy slug-only repo patch payloads into projectPath', () => {
    expect(parseUpdateRepoInput({
      slug: 'acme/renamed'
    })).toMatchObject({
      slug: 'acme/renamed',
      projectPath: 'acme/renamed'
    });
  });
});

describe('SCM credential validation', () => {
  it('parses provider credential payloads', () => {
    expect(parseUpsertScmCredentialInput({
      scmProvider: 'github',
      host: 'github.com',
      token: 'secret-token',
      label: 'Default GitHub'
    })).toMatchObject({
      scmProvider: 'github',
      host: 'github.com',
      token: 'secret-token',
      label: 'Default GitHub'
    });
  });

  it('rejects unknown providers', () => {
    expect(() =>
      parseUpsertScmCredentialInput({
        scmProvider: 'bitbucket',
        host: 'example.com',
        token: 'secret-token'
      })
    ).toThrow('Invalid scmProvider.');
  });
});
