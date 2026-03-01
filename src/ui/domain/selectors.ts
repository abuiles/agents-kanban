import type { AgentRun, BoardSnapshotV1, Repo, Task, TaskStatus } from './types';

export const TASK_COLUMNS: TaskStatus[] = ['INBOX', 'READY', 'ACTIVE', 'REVIEW', 'DONE', 'FAILED'];

export function getTasksForRepo(tasks: Task[], repoId: string | 'all'): Task[] {
  if (repoId === 'all') {
    return tasks;
  }

  return tasks.filter((task) => task.repoId === repoId);
}

export function getTasksByColumn(tasks: Task[]): Record<TaskStatus, Task[]> {
  return TASK_COLUMNS.reduce(
    (acc, column) => {
      acc[column] = tasks
        .filter((task) => task.status === column)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return acc;
    },
    {
      INBOX: [],
      READY: [],
      ACTIVE: [],
      REVIEW: [],
      DONE: [],
      FAILED: []
    } as Record<TaskStatus, Task[]>
  );
}

export function getRepoById(repos: Repo[], repoId: string): Repo | undefined {
  return repos.find((repo) => repo.repoId === repoId);
}

export function getLatestRunForTask(runs: AgentRun[], taskId: string): AgentRun | undefined {
  return runs
    .filter((run) => run.taskId === taskId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

export function getTaskDetail(snapshot: BoardSnapshotV1, taskId?: string) {
  if (!taskId) {
    return undefined;
  }

  const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    return undefined;
  }

  const repo = snapshot.repos.find((candidate) => candidate.repoId === task.repoId);
  if (!repo) {
    return undefined;
  }

  const runs = snapshot.runs
    .filter((run) => run.taskId === task.taskId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  return {
    task,
    repo,
    runs,
    latestRun: runs[0]
  };
}

export function getBaselineUrl(task: Task, repo?: Repo): string {
  return task.baselineUrlOverride ?? repo?.baselineUrl ?? 'https://baseline.example.invalid';
}
