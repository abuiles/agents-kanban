import { describe, expect, it, vi } from 'vitest';
import { LocalBoardStore } from '../store/local-board-store';
import { RunSimulator } from './run-simulator';
import { LocalAgentBoardApi } from './local-agent-board-api';

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

  it('provides terminal bootstrap and takeover state for active runs', async () => {
    const api = new LocalAgentBoardApi(new LocalBoardStore());
    const run = await api.startRun('task_landing');
    const bootstrap = await api.getTerminalBootstrap(run.runId);

    expect(bootstrap.attachable).toBe(true);
    expect(bootstrap.sessionName).toBe('operator');
    expect(bootstrap.llmResumeCommand).toBeUndefined();

    const updatedRun = await api.takeOverRun(run.runId);
    expect(updatedRun.operatorSession?.takeoverState).toBe('operator_control');
  });
});
