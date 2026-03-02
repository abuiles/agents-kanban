import { describe, expect, it } from 'vitest';
import { normalizeTaskSourceRef, resolveTaskSourceRef } from './source-ref';

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

  it('normalizes GitHub PR URLs into fetch specs', () => {
    expect(normalizeTaskSourceRef('https://github.com/abuiles/minions-demo/pull/4', 'abuiles/minions-demo')).toEqual({
      fetchSpec: 'pull/4/head',
      label: 'PR #4'
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
