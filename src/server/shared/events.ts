import type { AgentRun, OperatorSession, Repo, RunCommand, RunEvent, RunLogEntry, Task } from '../../ui/domain/types';
import type { ApiError } from '../http/errors';
import type { BoardSyncResponse } from './state';

export type BoardEvent =
  | { type: 'board.snapshot'; payload: BoardSyncResponse }
  | { type: 'repo.updated'; payload: { repo: Repo } }
  | { type: 'task.updated'; payload: { task: Task } }
  | { type: 'task.deleted'; payload: { taskId: string } }
  | { type: 'run.updated'; payload: { run: AgentRun } }
  | { type: 'run.logs_appended'; payload: { runId: string; logs: RunLogEntry[] } }
  | { type: 'run.events_appended'; payload: { runId: string; events: RunEvent[] } }
  | { type: 'run.commands_upserted'; payload: { runId: string; commands: RunCommand[] } }
  | { type: 'run.operator_session_updated'; payload: { runId: string; session?: OperatorSession } }
  | { type: 'server.error'; payload: ApiError };

export function stringifyBoardEvent(event: BoardEvent) {
  return JSON.stringify(event);
}
