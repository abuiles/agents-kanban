import type { Repo, Task } from '../ui/domain/types';
import type { NormalizedScmSourceRef } from './scm/adapter';
import { githubScmAdapter } from './scm/github';

export function resolveTaskSourceRef(task: Pick<Task, 'sourceRef' | 'title' | 'description' | 'taskPrompt'>) {
  return githubScmAdapter.inferSourceRefFromTask(task, buildLegacyGithubRepo('github.com/_'));
}

export function normalizeTaskSourceRef(sourceRef: string, expectedRepoSlug: string): NormalizedScmSourceRef {
  return githubScmAdapter.normalizeSourceRef(sourceRef, buildLegacyGithubRepo(expectedRepoSlug));
}

function buildLegacyGithubRepo(projectPath: string): Repo {
  return {
    repoId: 'legacy-source-ref',
    slug: projectPath,
    scmProvider: 'github',
    scmBaseUrl: 'https://github.com',
    projectPath,
    defaultBranch: 'main',
    baselineUrl: 'https://example.com',
    enabled: true,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z'
  };
}
