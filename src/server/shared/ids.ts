const TASK_PREFIX = 'task_';
const RUN_PREFIX = 'run_';

export function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

export function createRepoId(slug: string) {
  return `repo_${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || randomId()}`;
}

export function createTaskId(repoId: string) {
  return `${TASK_PREFIX}${repoId}_${randomId()}`;
}

export function createRunId(repoId: string) {
  return `${RUN_PREFIX}${repoId}_${Date.now().toString(36)}${randomId().slice(0, 4)}`;
}

export function extractRepoIdFromEntityId(entityId: string, prefix: typeof TASK_PREFIX | typeof RUN_PREFIX) {
  if (!entityId.startsWith(prefix)) {
    return undefined;
  }

  const withoutPrefix = entityId.slice(prefix.length);
  const lastSeparator = withoutPrefix.lastIndexOf('_');
  if (lastSeparator <= 0) {
    return undefined;
  }

  return withoutPrefix.slice(0, lastSeparator);
}

export function extractRepoIdFromTaskId(taskId: string) {
  return extractRepoIdFromEntityId(taskId, TASK_PREFIX);
}

export function extractRepoIdFromRunId(runId: string) {
  return extractRepoIdFromEntityId(runId, RUN_PREFIX);
}
