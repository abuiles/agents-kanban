import type { AgentRun, RunStatus, Task } from '../../../ui/domain/types';
import { buildIdempotencyKey } from '../idempotency';
import { listSlackThreadBindingsForTask, postSlackThreadMessage } from './client';

const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SlackLifecycleMilestone = 'queued' | 'running' | 'mr_open' | 'review_pending' | 'done' | 'failed';

export function mapRunStatusToLifecycleMilestone(status: RunStatus): SlackLifecycleMilestone | undefined {
  if (status === 'QUEUED') {
    return 'queued';
  }
  if (status === 'BOOTSTRAPPING' || status === 'RUNNING_CODEX' || status === 'RUNNING_TESTS' || status === 'PUSHING_BRANCH') {
    return 'running';
  }
  if (status === 'PR_OPEN') {
    return 'mr_open';
  }
  if (status === 'DONE') {
    return 'done';
  }
  if (status === 'FAILED') {
    return 'failed';
  }
  return undefined;
}

export function collectLifecycleMilestonesFromStatuses(statuses: RunStatus[]): SlackLifecycleMilestone[] {
  const milestones: SlackLifecycleMilestone[] = [];
  let previous: SlackLifecycleMilestone | undefined;
  for (const status of statuses) {
    const next = mapRunStatusToLifecycleMilestone(status);
    if (!next || next === previous) {
      continue;
    }
    milestones.push(next);
    previous = next;
  }
  return milestones;
}

function buildLifecycleMessage(run: AgentRun, milestone: SlackLifecycleMilestone) {
  if (milestone === 'queued') {
    return `Run ${run.runId} queued.`;
  }
  if (milestone === 'running') {
    return `Run ${run.runId} is running.`;
  }
  if (milestone === 'mr_open') {
    const reviewLabel = run.reviewNumber ?? run.prNumber ? `MR !${run.reviewNumber ?? run.prNumber}` : 'Merge request';
    if (run.reviewUrl ?? run.prUrl) {
      return `${reviewLabel} opened: ${run.reviewUrl ?? run.prUrl}`;
    }
    return `${reviewLabel} opened.`;
  }
  if (milestone === 'review_pending') {
    return run.reviewNumber ?? run.prNumber
      ? `Review pending on MR !${run.reviewNumber ?? run.prNumber}.`
      : 'Review pending.';
  }
  if (milestone === 'done') {
    return `Run ${run.runId} done.`;
  }
  return `Run ${run.runId} failed.`;
}

async function markDeliveryIfNew(env: Env, dedupeKey: string) {
  const seen = await env.SECRETS_KV.get(dedupeKey);
  if (seen) {
    return false;
  }
  await env.SECRETS_KV.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}

export async function mirrorRunLifecycleMilestone(
  env: Env,
  run: AgentRun,
  milestone: SlackLifecycleMilestone,
  eventId: string
) {
  const tenantId = run.tenantId;
  if (!tenantId) {
    return;
  }

  const bindings = await listSlackThreadBindingsForTask(env, tenantId, run.taskId);
  if (bindings.length === 0) {
    return;
  }

  const text = buildLifecycleMessage(run, milestone);
  await Promise.all(bindings.map(async (binding) => {
    const dedupeKey = buildIdempotencyKey({
      provider: 'slack',
      tenantId,
      eventType: `timeline.${milestone}`,
      providerEventId: eventId,
      subjectId: `${binding.channelId}:${binding.threadTs}`,
      metadata: {
        runId: run.runId,
        taskId: run.taskId
      }
    });
    const shouldDeliver = await markDeliveryIfNew(env, dedupeKey);
    if (!shouldDeliver) {
      return;
    }

    await postSlackThreadMessage(env, {
      tenantId,
      repoId: run.repoId,
      channelId: binding.channelId,
      threadTs: binding.threadTs,
      text
    }).catch(() => {
      // Slack timeline mirroring is best effort.
    });
  }));
}

export function truncateFeedbackText(note: string) {
  const compact = note.replace(/\s+/g, ' ').trim();
  if (compact.length <= 220) {
    return compact;
  }
  return `${compact.slice(0, 217)}...`;
}

function pluralize(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isSlackReviewOnlyTask(task: Pick<Task, 'title' | 'context'> | undefined) {
  if (!task) return false;
  const title = task.title?.trim() ?? '';
  const notes = task.context?.notes?.trim() ?? '';
  return title.startsWith('[Review]') || notes.includes('Created from Slack /kanvy review');
}

function buildSlackReviewCompletionMessage(run: AgentRun) {
  const summary = run.reviewFindingsSummary;
  const postedCount = summary?.posted ?? run.reviewPostState?.postedCount ?? 0;
  const findingsCount = summary?.total ?? run.reviewPostState?.findingsCount ?? 0;
  const openCount = summary?.open ?? 0;
  const reviewLabel = run.reviewProvider === 'gitlab'
    ? `MR !${run.reviewNumber ?? run.prNumber ?? 'unknown'}`
    : `PR #${run.reviewNumber ?? run.prNumber ?? 'unknown'}`;
  const reviewUrl = run.reviewUrl ?? run.prUrl;
  const urlSuffix = reviewUrl ? ` ${reviewUrl}` : '';

  if (postedCount > 0) {
    return `Review completed for ${reviewLabel}${urlSuffix}. We left ${pluralize(postedCount, 'comment', 'comments')} (${pluralize(openCount, 'open finding', 'open findings')}).`;
  }

  return `Review completed for ${reviewLabel}${urlSuffix}. ${pluralize(findingsCount, 'finding', 'findings')} generated; no review comments were posted.`;
}

export async function mirrorSlackReviewCompletion(
  env: Env,
  run: AgentRun,
  task: Pick<Task, 'title' | 'context'> | undefined,
  eventId: string
) {
  if (!run.tenantId || !isSlackReviewOnlyTask(task) || run.reviewExecution?.status !== 'completed') {
    return;
  }

  const bindings = await listSlackThreadBindingsForTask(env, run.tenantId, run.taskId);
  if (!bindings.length) {
    return;
  }

  const relevantBindings = bindings.filter((binding) => !binding.currentRunId || binding.currentRunId === run.runId);
  if (!relevantBindings.length) {
    return;
  }

  const text = buildSlackReviewCompletionMessage(run);
  await Promise.all(relevantBindings.map(async (binding) => {
    const dedupeKey = buildIdempotencyKey({
      provider: 'slack',
      tenantId: run.tenantId!,
      eventType: 'review.completed',
      providerEventId: eventId,
      subjectId: `${binding.channelId}:${binding.threadTs}`,
      metadata: {
        runId: run.runId,
        taskId: run.taskId,
        round: run.reviewExecution?.round ?? 0
      }
    });
    const shouldDeliver = await markDeliveryIfNew(env, dedupeKey);
    if (!shouldDeliver) return;

    await postSlackThreadMessage(env, {
      tenantId: run.tenantId!,
      repoId: run.repoId,
      channelId: binding.channelId,
      threadTs: binding.threadTs,
      text
    }).catch(() => {
      // Slack review completion mirroring is best effort.
    });
  }));
}

export function buildGitlabFeedbackSlackMessage(input: {
  reviewNumber: number;
  authorUsername?: string;
  note: string;
}) {
  const actor = input.authorUsername?.trim() ? `@${input.authorUsername.trim()}` : 'reviewer';
  return `GitLab feedback on MR !${input.reviewNumber} from ${actor}: ${truncateFeedbackText(input.note)}`;
}
