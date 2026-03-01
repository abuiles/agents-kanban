import { describe, expect, it, vi } from 'vitest';
import { LocalBoardStore } from '../store/local-board-store';
import { RunSimulator } from './run-simulator';

describe('run simulator', () => {
  it('creates a run and moves a task to active', () => {
    vi.useFakeTimers();
    const store = new LocalBoardStore();
    const simulator = new RunSimulator(store);
    const task = store.getSnapshot().tasks.find((candidate) => candidate.taskId === 'task_landing');
    expect(task).toBeDefined();
    const run = simulator.createRun(task!);
    expect(run.status).toBe('QUEUED');
    expect(store.getSnapshot().tasks.find((candidate) => candidate.taskId === 'task_landing')?.status).toBe('ACTIVE');
    vi.useRealTimers();
  });
});
