import type { Repo } from '../../../ui/domain/types';
import * as tenantAuthDb from '../../tenant-auth-db';
import { json, handleError } from '../../http/response';
import { buildIdempotencyKey } from '../idempotency';
import { getRepoProjectPath, getRepoScmProvider, getRunReviewNumber } from '../../../shared/scm';
import { verifyGitlabWebhookSecret } from './verification';
import { normalizeGitlabReviewEvent } from './normalize';
import {
  buildGitlabFeedbackSlackMessage,
  mirrorRunLifecycleMilestone
} from '../slack/timeline';
import { listSlackThreadBindingsForTask, postSlackThreadMessage } from '../slack/client';

const BOARD_OBJECT_NAME = 'agentboard';
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

async function resolveTenantId(env: Env) {
  return tenantAuthDb.getPrimaryTenantId(env);
}

async function resolveRepoByProjectPath(env: Env, tenantId: string, projectPath: string): Promise<Repo | undefined> {
  const board = env.BOARD_INDEX.getByName(BOARD_OBJECT_NAME);
  const repos = await board.listRepos(tenantId);
  const normalizedTarget = projectPath.trim().toLowerCase();
  return repos.find((repo) => (
    getRepoScmProvider(repo) === 'gitlab'
    && getRepoProjectPath(repo).toLowerCase() === normalizedTarget
  ));
}

async function shouldProcessDelivery(env: Env, key: string) {
  const existing = await env.SECRETS_KV.get(key);
  if (existing) {
    return false;
  }
  await env.SECRETS_KV.put(key, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function readDeliveryId(request: Request, rawBody: string, normalizedProviderEventId: string) {
  const fromHeader = request.headers.get('x-gitlab-event-uuid')?.trim();
  if (fromHeader) {
    return fromHeader;
  }
  return `${normalizedProviderEventId}:${hashText(rawBody)}`;
}

export async function handleGitlabWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const tenantId = await resolveTenantId(env);
    await verifyGitlabWebhookSecret(env, tenantId, request);
    const rawBody = await request.text();
    const payload = JSON.parse(rawBody) as unknown;
    const normalized = normalizeGitlabReviewEvent(payload);
    if (!normalized) {
      return json({ ok: true, status: 'ignored' });
    }

    const deliveryId = readDeliveryId(request, rawBody, normalized.providerEventId);
    const deliveryDedupeKey = buildIdempotencyKey({
      provider: 'gitlab',
      tenantId,
      eventType: 'webhook.delivery',
      providerEventId: deliveryId,
      subjectId: normalized.projectPath,
      metadata: { reviewNumber: normalized.reviewNumber }
    });
    if (!(await shouldProcessDelivery(env, deliveryDedupeKey))) {
      return json({ ok: true, status: 'duplicate_delivery' });
    }

    const repo = await resolveRepoByProjectPath(env, tenantId, normalized.projectPath);
    if (!repo) {
      return json({ ok: true, status: 'ignored_repo_unmapped' });
    }

    const repoBoard = env.REPO_BOARD.getByName(repo.repoId);
    const slice = await repoBoard.getBoardSlice();
    const run = [...slice.runs]
      .filter((candidate) => getRunReviewNumber(candidate) === normalized.reviewNumber)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .at(0);
    if (!run) {
      return json({ ok: true, status: 'ignored_run_unmapped' });
    }

    if (normalized.type === 'review_pending') {
      await mirrorRunLifecycleMilestone(env, run, 'review_pending', `${deliveryId}:review_pending`);
      return json({ ok: true, status: 'mirrored_review_pending', runId: run.runId });
    }

    await mirrorRunLifecycleMilestone(env, run, 'review_pending', `${deliveryId}:review_pending`);
    const bindings = await listSlackThreadBindingsForTask(env, tenantId, run.taskId);
    const message = buildGitlabFeedbackSlackMessage({
      reviewNumber: normalized.reviewNumber,
      authorUsername: normalized.authorUsername,
      note: normalized.note ?? ''
    });

    await Promise.all(bindings.map(async (binding) => {
      const dedupeKey = buildIdempotencyKey({
        provider: 'gitlab',
        tenantId,
        eventType: 'review_feedback',
        providerEventId: `${deliveryId}:${normalized.providerEventId}`,
        subjectId: `${binding.channelId}:${binding.threadTs}`,
        metadata: {
          runId: run.runId,
          reviewNumber: normalized.reviewNumber
        }
      });
      if (!(await shouldProcessDelivery(env, dedupeKey))) {
        return;
      }

      await postSlackThreadMessage(env, {
        tenantId,
        repoId: run.repoId,
        channelId: binding.channelId,
        threadTs: binding.threadTs,
        text: message
      }).catch(() => {
        // Slack mirroring is best effort.
      });
    }));

    return json({ ok: true, status: 'mirrored_feedback', runId: run.runId });
  } catch (error) {
    return handleError(error);
  }
}
