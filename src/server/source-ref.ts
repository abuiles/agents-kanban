import type { Repo, Task } from '../ui/domain/types';
import { githubScmAdapter } from './scm/github';
import { getScmAdapter } from './scm/registry';
import type { LegacyNormalizedScmSourceRef, ScmSourceRef } from './scm/source-ref';
import { toLegacyNormalizedScmSourceRef } from './scm/source-ref';

export function resolveTaskSourceRef(task: Pick<Task, 'sourceRef' | 'title' | 'description' | 'taskPrompt'>) {
  return githubScmAdapter.inferSourceRefFromTask(task, buildLegacyGithubRepo('github.com/_'));
}

export function normalizeScmSourceRef(sourceRef: string, repo: Repo): ScmSourceRef {
  return getScmAdapter(repo).normalizeSourceRef(sourceRef, repo);
}

export function normalizeTaskSourceRef(sourceRef: string, expectedRepoSlug: string): LegacyNormalizedScmSourceRef {
  return toLegacyNormalizedScmSourceRef(normalizeScmSourceRef(sourceRef, buildLegacyGithubRepo(expectedRepoSlug)));
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
