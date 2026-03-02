import { describe, expect, it } from 'vitest';
import { parseCreateTaskInput, parseUpdateTaskInput } from './validation';

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
