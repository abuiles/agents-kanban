import { describe, expect, it } from 'vitest';
import { normalizeScmSourceRef, normalizeTaskSourceRef, resolveTaskSourceRef } from './source-ref';

describe('source-ref', () => {
  it('resolves an explicit task source ref before context links', () => {
    expect(
      resolveTaskSourceRef({
        sourceRef: 'feature/minions',
        title: 'Clone PR #4',
        taskPrompt: 'Start from PR #4 and update the game.'
      })
    ).toBe('feature/minions');
  });

  it('falls back to a GitHub PR reference in the task text', () => {
    expect(
      resolveTaskSourceRef({
        title: 'Clone PR #4 and build a Minions snake-style game',
        taskPrompt: 'Use the PR #4 branch as the starting point.'
      })
    ).toBe('pull/4/head');
  });

  it('does not infer a fake branch from generic "source" wording', () => {
    expect(
      resolveTaskSourceRef({
        title: 'S31-04 Source resolution precedence',
        taskPrompt: 'Implement deterministic source resolution for run start.'
      })
    ).toBeUndefined();
  });

  it('normalizes GitHub PR URLs into fetch specs', () => {
    expect(normalizeTaskSourceRef('https://github.com/abuiles/minions-demo/pull/4', 'abuiles/minions-demo')).toEqual({
      fetchSpec: 'pull/4/head',
      label: 'PR #4'
    });
  });

  it('returns a provider-neutral review-head source ref for GitHub PR URLs', () => {
    expect(normalizeScmSourceRef('https://github.com/abuiles/minions-demo/pull/4', {
      repoId: 'repo_demo',
      slug: 'abuiles/minions-demo',
      scmProvider: 'github',
      scmBaseUrl: 'https://github.com',
      projectPath: 'abuiles/minions-demo',
      defaultBranch: 'main',
      baselineUrl: 'https://example.com',
      enabled: true,
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z'
    })).toEqual({
      kind: 'review_head',
      value: 'pull/4/head',
      label: 'PR #4',
      reviewNumber: 4,
      reviewProvider: 'github'
    });
  });

  it('normalizes GitHub branch URLs into fetch specs', () => {
    expect(
      normalizeTaskSourceRef('https://github.com/abuiles/minions-demo/tree/feature/minions', 'abuiles/minions-demo')
    ).toEqual({
      fetchSpec: 'feature/minions',
      label: 'branch feature/minions'
    });
  });

  it('keeps plain refs unchanged', () => {
    expect(normalizeTaskSourceRef('feature/minions', 'abuiles/minions-demo')).toEqual({
      fetchSpec: 'feature/minions',
      label: 'feature/minions'
    });
  });

  it('rejects GitHub source refs for the wrong repository', () => {
    expect(() => normalizeTaskSourceRef('https://github.com/openai/codex/pull/1', 'abuiles/minions-demo')).toThrow(
      'Task source ref points to openai/codex, expected abuiles/minions-demo.'
    );
  });
});
