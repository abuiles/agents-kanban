import type { AgentRun, Repo, RunLogEntry, Task } from '../../ui/domain/types';
import type { ApiError } from '../http/errors';
import type { BoardSyncResponse } from './state';

export type BoardEvent =
  | { type: 'board.snapshot'; payload: BoardSyncResponse }
  | { type: 'repo.updated'; payload: { repo: Repo } }
  | { type: 'task.updated'; payload: { task: Task } }
  | { type: 'run.updated'; payload: { run: AgentRun } }
  | { type: 'run.logs_appended'; payload: { runId: string; logs: RunLogEntry[] } }
  | { type: 'server.error'; payload: ApiError };

export function stringifyBoardEvent(event: BoardEvent) {
  return JSON.stringify(event);
}
