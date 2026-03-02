import { describe, expect, it } from 'vitest';
import { parseCreateRepoInput, parseCreateTaskInput, parseUpdateRepoInput, parseUpdateTaskInput, parseUpsertProviderCredentialInput } from './validation';

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
          upstreamPrNumber: 0,
          resolvedRef: 'refs/heads/demo',
          resolvedAt: '2026-03-02T00:00:00.000Z'
        }
      })
    ).toThrow('Invalid branchSource.upstreamPrNumber.');
  });
});

describe('repo validation', () => {
  it('parses legacy GitHub repo payloads with slug fallback', () => {
    const parsed = parseCreateRepoInput({
      slug: 'abuiles/minions',
      baselineUrl: 'https://minions.example.com'
    });

    expect(parsed.slug).toBe('abuiles/minions');
    expect(parsed.projectPath).toBe('abuiles/minions');
    expect(parsed.scmProvider).toBeUndefined();
    expect(parsed.scmBaseUrl).toBeUndefined();
  });

  it('parses provider-neutral repo payloads', () => {
    const parsed = parseCreateRepoInput({
      scmProvider: 'gitlab',
      scmBaseUrl: 'https://gitlab.example.com/',
      projectPath: 'group/subgroup/project',
      baselineUrl: 'https://preview.example.com',
      defaultBranch: 'main'
    });

    expect(parsed.slug).toBe('group/subgroup/project');
    expect(parsed.projectPath).toBe('group/subgroup/project');
    expect(parsed.scmProvider).toBe('gitlab');
    expect(parsed.scmBaseUrl).toBe('https://gitlab.example.com/');
  });

  it('mirrors slug and projectPath in repo patches', () => {
    const parsed = parseUpdateRepoInput({
      projectPath: 'acme/platform'
    });

    expect(parsed.projectPath).toBe('acme/platform');
    expect(parsed.slug).toBe('acme/platform');
  });
});

describe('provider credential validation', () => {
  it('parses provider credential payloads', () => {
    const parsed = parseUpsertProviderCredentialInput({
      scmProvider: 'github',
      scmBaseUrl: 'https://github.example.com',
      secretRef: {
        storage: 'kv',
        key: 'github_pat_enterprise'
      },
      label: 'GitHub Enterprise'
    });

    expect(parsed.scmProvider).toBe('github');
    expect(parsed.secretRef.storage).toBe('kv');
    expect(parsed.secretRef.key).toBe('github_pat_enterprise');
  });

  it('rejects provider credential payloads with raw token fields instead of secret refs', () => {
    expect(() =>
      parseUpsertProviderCredentialInput({
        scmProvider: 'github',
        token: 'ghp_secret',
        secretRef: 'github_pat'
      })
    ).toThrow('Invalid secretRef.');
  });
});
