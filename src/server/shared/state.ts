import type { AgentRun, BoardSnapshotV1, Repo, RunCommand, RunEvent, RunLogEntry, Task } from '../../ui/domain/types';

export type RepoBoardState = {
  tasks: Task[];
  runs: AgentRun[];
  logs: RunLogEntry[];
  events: RunEvent[];
  commands: RunCommand[];
};

export type BoardSyncResponse = {
  repos: Repo[];
  tasks: Task[];
  runs: AgentRun[];
  logs: RunLogEntry[];
  events: RunEvent[];
  commands: RunCommand[];
};

export const TERMINAL_RUN_STATUSES = new Set<AgentRun['status']>(['DONE', 'FAILED']);

export const EMPTY_REPO_BOARD_STATE: RepoBoardState = {
  tasks: [],
  runs: [],
  logs: [],
  events: [],
  commands: []
};

export function buildBoardSnapshot(sync: BoardSyncResponse): BoardSnapshotV1 {
  return {
    version: 1,
    repos: sync.repos,
    tasks: sync.tasks,
    runs: sync.runs,
    logs: sync.logs,
    events: sync.events,
    commands: sync.commands,
    ui: {
      selectedRepoId: 'all',
      seeded: false
    }
  };
}
