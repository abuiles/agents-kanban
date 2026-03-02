import type { Repo } from '../../ui/domain/types';

export function shouldRunPreview(repo: Repo) {
  return repo.previewMode !== 'skip';
}

export function shouldRunEvidence(repo: Repo) {
  return repo.evidenceMode !== 'skip';
}
