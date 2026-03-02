import type { AgentRun, BoardSnapshotV1, Repo, RunLogEntry, Task } from '../../ui/domain/types';

export type RepoBoardState = {
  tasks: Task[];
  runs: AgentRun[];
  logs: RunLogEntry[];
};

export type BoardSyncResponse = {
  repos: Repo[];
  tasks: Task[];
  runs: AgentRun[];
  logs: RunLogEntry[];
};

export const EMPTY_REPO_BOARD_STATE: RepoBoardState = {
  tasks: [],
  runs: [],
  logs: []
};

export function buildBoardSnapshot(sync: BoardSyncResponse): BoardSnapshotV1 {
  return {
    version: 1,
    repos: sync.repos,
    tasks: sync.tasks,
    runs: sync.runs,
    logs: sync.logs,
    ui: {
      selectedRepoId: 'all',
      seeded: false
    }
  };
}
