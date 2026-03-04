import type { AutoReviewProvider } from '../../ui/domain/types';
import type { ReviewPostingAdapter } from './adapter';
import { GitHubReviewPostingAdapter } from './github';
import { GitLabReviewPostingAdapter } from './gitlab';
import { JiraReviewPostingAdapter } from './jira';

const adapters: Record<AutoReviewProvider, ReviewPostingAdapter> = {
  github: new GitHubReviewPostingAdapter(),
  gitlab: new GitLabReviewPostingAdapter(),
  jira: new JiraReviewPostingAdapter()
};

export function getReviewPostingAdapter(provider: AutoReviewProvider): ReviewPostingAdapter {
  return adapters[provider];
}
