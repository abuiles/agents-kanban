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
    const explicitCandidates = checkpoints.filter((checkpoint) => checkpoint.checkpointId === input.checkpointId);
    if (!explicitCandidates.length) {
      return {
        strategy: 'fresh',
        timelineNote: `Checkpoint recovery unavailable (reason=checkpoint_not_found, checkpointId=${input.checkpointId}); falling back to fresh retry from standard source resolution.`
      };
    }
    const explicit = selectLatestCheckpoint(explicitCandidates);
    if (!explicit) {
      return {
        strategy: 'fresh',
        timelineNote: `Checkpoint recovery unavailable (reason=checkpoint_invalid, checkpointId=${input.checkpointId}); falling back to fresh retry from standard source resolution.`
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

  const latestById = new Map<string, RunCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (!isUsableCheckpoint(checkpoint)) {
      continue;
    }
    const existing = latestById.get(checkpoint.checkpointId);
    if (!existing || compareCheckpoints(checkpoint, existing) > 0) {
      latestById.set(checkpoint.checkpointId, checkpoint);
    }
  }
  return [...latestById.values()];
}

function selectLatestCheckpoint(checkpoints: RunCheckpoint[]) {
  let latest: RunCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (!latest) {
      latest = checkpoint;
      continue;
    }
    if (compareCheckpoints(checkpoint, latest) > 0) {
      latest = checkpoint;
    }
  }
  return latest;
}

function compareCheckpoints(left: RunCheckpoint, right: RunCheckpoint) {
  const sequenceDiff = extractCheckpointSequence(left.checkpointId) - extractCheckpointSequence(right.checkpointId);
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }
  const createdAtDiff = left.createdAt.localeCompare(right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  const idDiff = left.checkpointId.localeCompare(right.checkpointId);
  if (idDiff !== 0) {
    return idDiff;
  }
  return left.commitSha.localeCompare(right.commitSha);
}

function extractCheckpointSequence(checkpointId: string) {
  const match = checkpointId.match(/:cp:(\d{3,}):/);
  if (!match) {
    return Number.MIN_SAFE_INTEGER;
  }
  const sequence = Number.parseInt(match[1], 10);
  return Number.isFinite(sequence) ? sequence : Number.MIN_SAFE_INTEGER;
}

function isUsableCheckpoint(checkpoint: unknown): checkpoint is RunCheckpoint {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return false;
  }
  const candidate = checkpoint as Partial<RunCheckpoint>;
  if (typeof candidate.checkpointId !== 'string' || !candidate.checkpointId.trim()) {
    return false;
  }
  if (typeof candidate.createdAt !== 'string' || !candidate.createdAt.trim()) {
    return false;
  }
  if (typeof candidate.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(candidate.commitSha)) {
    return false;
  }
  return true;
}

function shortSha(commitSha: string) {
  return commitSha.slice(0, 12);
}
