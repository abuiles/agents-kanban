import type { RunJobParams } from './shared/real-run';

export function buildWorkflowInvocationId(params: RunJobParams, now = new Date()) {
  const timestamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return `${params.mode.replaceAll('_', '-')}-${params.runId}-${timestamp}`;
}
