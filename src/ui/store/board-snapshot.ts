import type { BoardSnapshotV1 } from '../domain/types';

export const BOARD_STORAGE_KEY = 'agentboard.snapshot.v1';

export function isBoardSnapshot(value: unknown): value is BoardSnapshotV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshot = value as Partial<BoardSnapshotV1>;
  return snapshot.version === 1
    && Array.isArray(snapshot.repos)
    && Array.isArray(snapshot.tasks)
    && Array.isArray(snapshot.runs)
    && Array.isArray(snapshot.logs)
    && Array.isArray(snapshot.events)
    && Array.isArray(snapshot.commands);
}

export function parseBoardSnapshot(serialized: string): BoardSnapshotV1 {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isBoardSnapshot(parsed)) {
    throw new Error('Invalid AgentBoard snapshot.');
  }

  return parsed;
}
