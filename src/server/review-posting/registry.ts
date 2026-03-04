import type { AutoReviewProvider } from '../../ui/domain/types';
import type { ReviewPostingAdapter } from './adapter';
import { GitLabReviewPostingAdapter } from './gitlab';
import { JiraReviewPostingAdapter } from './jira';

const adapters: Record<Exclude<AutoReviewProvider, 'github'>, ReviewPostingAdapter> = {
  gitlab: new GitLabReviewPostingAdapter(),
  jira: new JiraReviewPostingAdapter()
};

export function getReviewPostingAdapter(provider: AutoReviewProvider): ReviewPostingAdapter {
  if (provider === 'github') {
    throw new Error('GitHub auto-review posting is not available yet.');
  }
  return adapters[provider];
}
