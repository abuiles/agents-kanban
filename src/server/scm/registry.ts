import { getRepoScmProvider } from '../../shared/scm';
import type { Repo } from '../../ui/domain/types';
import type { ScmAdapter } from './adapter';
import { githubScmAdapter } from './github';

export function getScmAdapter(repo: Repo): ScmAdapter {
  const provider = getRepoScmProvider(repo);
  if (provider === 'github') {
    return githubScmAdapter;
  }

  throw new Error(`SCM provider ${provider} is not supported yet.`);
}
