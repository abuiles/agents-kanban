import type { RetryRunInput } from '../../ui/domain/api';
import type { AgentRun, RunCheckpoint } from '../../ui/domain/types';

export type RetryRecoveryDecision =
  | {
      strategy: 'checkpoint';
      checkpoint: RunCheckpoint;
      resumedFromCheckpointId: string;
      resumedFromCommitSha: string;
      timelineNote: string;
    }
  | {
      strategy: 'fresh';
      timelineNote: string;
    };

export function resolveRetryRecoveryDecision(
  run: Pick<AgentRun, 'checkpoints'>,
  input?: RetryRunInput
): RetryRecoveryDecision {
  const recoveryMode = input?.recoveryMode ?? 'latest_checkpoint';
  if (recoveryMode === 'fresh') {
    return {
      strategy: 'fresh',
      timelineNote: 'Retry mode set to fresh; starting from standard source resolution.'
    };
  }

  const checkpoints = normalizeCheckpoints(run.checkpoints);
  if (!checkpoints.length) {
    return {
      strategy: 'fresh',
      timelineNote: 'Checkpoint recovery unavailable (reason=no_checkpoints); falling back to fresh retry from standard source resolution.'
    };
  }

  if (input?.checkpointId) {
    const explicit = checkpoints.find((checkpoint) => checkpoint.checkpointId === input.checkpointId);
    if (!explicit) {
      return {
        strategy: 'fresh',
        timelineNote: `Checkpoint recovery unavailable (reason=checkpoint_not_found, checkpointId=${input.checkpointId}); falling back to fresh retry from standard source resolution.`
      };
    }
    return {
      strategy: 'checkpoint',
      checkpoint: explicit,
      resumedFromCheckpointId: explicit.checkpointId,
      resumedFromCommitSha: explicit.commitSha,
      timelineNote: `Retry recovering from checkpoint ${explicit.checkpointId} at commit ${shortSha(explicit.commitSha)}.`
    };
  }

  const latest = selectLatestCheckpoint(checkpoints);
  if (!latest) {
    return {
      strategy: 'fresh',
      timelineNote: 'Checkpoint recovery unavailable (reason=no_checkpoints); falling back to fresh retry from standard source resolution.'
    };
  }

  return {
    strategy: 'checkpoint',
    checkpoint: latest,
    resumedFromCheckpointId: latest.checkpointId,
    resumedFromCommitSha: latest.commitSha,
    timelineNote: `Retry recovering from latest checkpoint ${latest.checkpointId} at commit ${shortSha(latest.commitSha)}.`
  };
}

function normalizeCheckpoints(checkpoints: AgentRun['checkpoints']) {
  if (!Array.isArray(checkpoints)) {
    return [];
  }
  return checkpoints.filter((checkpoint): checkpoint is RunCheckpoint => Boolean(checkpoint));
}

function selectLatestCheckpoint(checkpoints: RunCheckpoint[]) {
  let latest: RunCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (!latest) {
      latest = checkpoint;
      continue;
    }
    if (checkpoint.createdAt > latest.createdAt) {
      latest = checkpoint;
      continue;
    }
    if (checkpoint.createdAt === latest.createdAt && checkpoint.checkpointId > latest.checkpointId) {
      latest = checkpoint;
    }
  }
  return latest;
}

function shortSha(commitSha: string) {
  return commitSha.slice(0, 12);
}
