import type { RunJobParams } from './shared/real-run';

const WORKFLOW_INSTANCE_ID_MAX_LENGTH = 100;
const WORKFLOW_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

function normalizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]/g, '-');
}

function ensureValidStart(value: string) {
  return /^[a-zA-Z0-9_]/.test(value) ? value : `w${value}`;
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildWorkflowInvocationId(params: RunJobParams, now = new Date()) {
  const mode = normalizeSegment(params.mode);
  const runId = normalizeSegment(params.runId);
  const timestamp = now.getTime().toString(36);
  const hash = shortHash(`${mode}:${runId}:${timestamp}`).slice(0, 8);

  let id = ensureValidStart(`${mode}-${runId}-${timestamp}-${hash}`);
  if (id.length > WORKFLOW_INSTANCE_ID_MAX_LENGTH) {
    const suffix = `${timestamp}-${hash}`;
    const remaining = WORKFLOW_INSTANCE_ID_MAX_LENGTH - mode.length - suffix.length - 2;
    const truncatedRunId = remaining > 0 ? runId.slice(-remaining) : '';
    id = ensureValidStart(`${mode}-${truncatedRunId}-${suffix}`);
  }

  if (!WORKFLOW_INSTANCE_ID_PATTERN.test(id) || id.length > WORKFLOW_INSTANCE_ID_MAX_LENGTH) {
    id = ensureValidStart(`${mode}-${timestamp}-${hash}`.slice(0, WORKFLOW_INSTANCE_ID_MAX_LENGTH));
  }

  return id;
}
