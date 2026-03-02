import { describe, expect, it } from 'vitest';
import { buildWorkflowInvocationId } from './workflow-id';

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
