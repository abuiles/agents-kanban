import type { AgentRun, Task, TaskBranchSource } from '../../ui/domain/types';
import { isDependencyMergedToDefaultBranch, isDependencyReviewReady } from './dependency-readiness';

type ResolveRunSourceInput = {
  task: Task;
  tasks: Task[];
  runs: AgentRun[];
  defaultBranch: string;
  resolvedAt: string;
};

type ResolvedRunSource = {
  branchSource: TaskBranchSource;
  dependencyContext: NonNullable<AgentRun['dependencyContext']>;
};

export function resolveRunSource({
  task,
  tasks,
  runs,
  defaultBranch,
  resolvedAt
}: ResolveRunSourceInput): ResolvedRunSource {
  const explicitSourceRef = task.sourceRef?.trim();
  if (explicitSourceRef) {
    return {
      branchSource: {
        kind: 'explicit_source_ref',
        resolvedRef: explicitSourceRef,
        resolvedAt
      },
      dependencyContext: {
        sourceMode: 'explicit_source_ref'
      }
    };
  }

  const dependencyReviewSource = resolveDependencyReviewSource(task, tasks, runs, resolvedAt);
  if (dependencyReviewSource) {
    return dependencyReviewSource;
  }

  return {
    branchSource: {
      kind: 'default_branch',
      resolvedRef: defaultBranch,
      resolvedAt
    },
    dependencyContext: {
      sourceMode: 'default_branch'
    }
  };
}

function resolveDependencyReviewSource(task: Task, tasks: Task[], runs: AgentRun[], resolvedAt: string): ResolvedRunSource | undefined {
  const dependency = pickDependencyForLineage(task);
  if (!dependency) {
    return undefined;
  }

  const upstreamTask = tasks.find((candidate) => candidate.taskId === dependency.upstreamTaskId);
  if (!upstreamTask) {
    return undefined;
  }

  const upstreamRun = getLatestRunForTask(runs, dependency.upstreamTaskId);
  if (!upstreamRun) {
    return undefined;
  }

  if (isDependencyMergedToDefaultBranch(upstreamTask, upstreamRun)) {
    return undefined;
  }

  if (!isDependencyReviewReady(upstreamTask, upstreamRun) || !upstreamRun.headSha || !upstreamRun.prNumber) {
    return undefined;
  }

  return {
    branchSource: {
      kind: 'dependency_review_head',
      upstreamTaskId: upstreamTask.taskId,
      upstreamRunId: upstreamRun.runId,
      upstreamPrNumber: upstreamRun.prNumber,
      upstreamHeadSha: upstreamRun.headSha,
      resolvedRef: upstreamRun.headSha,
      resolvedAt
    },
    dependencyContext: {
      sourceTaskId: upstreamTask.taskId,
      sourceRunId: upstreamRun.runId,
      sourcePrNumber: upstreamRun.prNumber,
      sourceHeadSha: upstreamRun.headSha,
      sourceMode: 'dependency_review_head'
    }
  };
}

function pickDependencyForLineage(task: Task) {
  const dependencies = task.dependencies ?? [];
  if (!dependencies.length) {
    return undefined;
  }

  if (dependencies.length === 1) {
    return dependencies[0];
  }

  const primaryDependencies = dependencies.filter((dependency) => dependency.primary);
  if (primaryDependencies.length !== 1) {
    return undefined;
  }

  return primaryDependencies[0];
}

function getLatestRunForTask(runs: AgentRun[], taskId: string) {
  let latestRun: AgentRun | undefined;
  for (const run of runs) {
    if (run.taskId !== taskId) {
      continue;
    }
    if (!latestRun || run.startedAt > latestRun.startedAt) {
      latestRun = run;
    }
  }
  return latestRun;
}
