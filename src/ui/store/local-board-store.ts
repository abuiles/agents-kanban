import type { BoardSnapshotV1 } from '../domain/types';
import { BOARD_STORAGE_KEY, parseBoardSnapshot } from './board-snapshot';
import { createSeedSnapshot } from './seed-data';

export class LocalBoardStore {
  private snapshot: BoardSnapshotV1;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.snapshot = this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): BoardSnapshotV1 {
    return this.snapshot;
  }

  replaceSnapshot(snapshot: BoardSnapshotV1) {
    this.snapshot = snapshot;
    this.persist();
    this.emit();
  }

  update(mutator: (current: BoardSnapshotV1) => BoardSnapshotV1) {
    this.snapshot = mutator(this.snapshot);
    this.persist();
    this.emit();
  }

  export(): string {
    return JSON.stringify(this.snapshot, null, 2);
  }

  private load(): BoardSnapshotV1 {
    if (typeof localStorage === 'undefined') {
      return createSeedSnapshot();
    }

    const existing = localStorage.getItem(BOARD_STORAGE_KEY);
    if (!existing) {
      const seed = createSeedSnapshot();
      localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify(seed));
      return seed;
    }

    return parseBoardSnapshot(existing);
  }

  private persist() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify(this.snapshot));
    }
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
