import { describe, expect, it } from 'vitest';
import { buildWorkflowInvocationId } from './workflow-id';
import type { RunJobParams } from './shared/real-run';

const CLOUDFLARE_WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

function makeParams(runId: string): RunJobParams {
  return {
    tenantId: 'tenant_legacy',
    repoId: 'repo_example',
    taskId: 'task_example',
    runId,
    mode: 'full_run'
  };
}

describe('buildWorkflowInvocationId', () => {
  it('builds a cloudflare-compatible workflow instance id', () => {
    const id = buildWorkflowInvocationId(makeParams('run_repo_example_123'), new Date('2026-03-02T22:30:00.000Z'));

    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toMatch(CLOUDFLARE_WORKFLOW_ID_PATTERN);
  });

  it('caps long workflow instance ids at 100 characters', () => {
    const longRunId = 'run_repo_gitlab_gitlab_rechargeapps_net_engineering_frontend_frontend_abcdefghijklmnopqrstuvwxyz0123456789';
    const id = buildWorkflowInvocationId(makeParams(longRunId), new Date('2026-03-02T22:30:00.000Z'));

    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toMatch(CLOUDFLARE_WORKFLOW_ID_PATTERN);
  });
});
