import type { AutoReviewProvider } from '../../ui/domain/types';
import type { ReviewPostingAdapter } from './adapter';
import { GitLabReviewPostingAdapter } from './gitlab';
import { JiraReviewPostingAdapter } from './jira';

const adapters: Record<AutoReviewProvider, ReviewPostingAdapter> = {
  gitlab: new GitLabReviewPostingAdapter(),
  jira: new JiraReviewPostingAdapter()
};

export function getReviewPostingAdapter(provider: AutoReviewProvider): ReviewPostingAdapter {
  return adapters[provider];
}
