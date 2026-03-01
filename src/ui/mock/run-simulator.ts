import type { AgentRun, ArtifactManifest, RunLogEntry, RunStatus, Task } from '../domain/types';
import { buildLogsForStatus } from './log-builder';
import { buildSimulationPlan } from './run-templates';
import { getBaselineUrl } from '../domain/selectors';
import { LocalBoardStore } from '../store/local-board-store';

const terminalStatuses: RunStatus[] = ['DONE', 'FAILED'];

function isTerminal(status: RunStatus) {
  return terminalStatuses.includes(status);
}

export class RunSimulator {
  private readonly timers = new Map<string, number>();

  constructor(private readonly store: LocalBoardStore) {}

  resumeAll() {
    const snapshot = this.store.getSnapshot();
    for (const run of snapshot.runs.filter((candidate) => !isTerminal(candidate.status))) {
      this.scheduleRun(run.runId);
    }
  }

  scheduleRun(runId: string) {
    this.clearRunTimers(runId);
    while (true) {
      const run = this.store.getSnapshot().runs.find((candidate) => candidate.runId === runId);
      if (!run) {
        return;
      }

      const overdueEvent = run.pendingEvents.find((event) => new Date(event.executeAt).getTime() <= Date.now());
      if (!overdueEvent) {
        for (const event of run.pendingEvents) {
          const delay = new Date(event.executeAt).getTime() - Date.now();
          const timer = window.setTimeout(() => this.advanceRun(runId, event.status, event.note), delay);
          this.timers.set(`${runId}:${event.status}:${event.executeAt}`, timer);
        }
        return;
      }

      this.advanceRun(runId, overdueEvent.status, overdueEvent.note);
      if (isTerminal(overdueEvent.status)) {
        return;
      }
    }
  }

  createRun(task: Task): AgentRun {
    const startedAt = new Date();
    const runId = `run_${task.taskId}_${startedAt.getTime()}`;
    const profile = task.uiMeta?.simulationProfile ?? 'happy_path';
    const run: AgentRun = {
      runId,
      taskId: task.taskId,
      repoId: task.repoId,
      status: 'QUEUED',
      branchName: `agent/${task.taskId}/${runId}`,
      errors: [],
      startedAt: startedAt.toISOString(),
      timeline: [],
      simulationProfile: profile,
      pendingEvents: buildSimulationPlan(startedAt, profile)
    };

    this.store.update((snapshot) => ({
      ...snapshot,
      tasks: snapshot.tasks.map((candidate) =>
        candidate.taskId === task.taskId
          ? { ...candidate, status: 'ACTIVE', runId, updatedAt: startedAt.toISOString() }
          : candidate
      ),
      runs: [run, ...snapshot.runs]
    }));

    this.scheduleRun(runId);
    return this.store.getSnapshot().runs.find((candidate) => candidate.runId === runId)!;
  }

  retryEvidence(runId: string): AgentRun {
    const now = new Date().toISOString();
    this.store.update((snapshot) => ({
      ...snapshot,
      runs: snapshot.runs.map((run) => {
        if (run.runId !== runId) {
          return run;
        }

        const pendingEvents = [
          { status: 'EVIDENCE_RUNNING' as const, executeAt: now },
          { status: 'DONE' as const, executeAt: new Date(Date.now() + 4_000).toISOString() }
        ];

        return {
          ...run,
          status: 'WAITING_PREVIEW',
          endedAt: undefined,
          pendingEvents,
          timeline: [...run.timeline, { status: 'WAITING_PREVIEW', at: now, note: 'Retrying evidence only.' }]
        };
      })
    }));

    this.scheduleRun(runId);
    return this.store.getSnapshot().runs.find((candidate) => candidate.runId === runId)!;
  }

  private advanceRun(runId: string, status: RunStatus, note?: string) {
    const now = new Date().toISOString();
    let generatedLogs: RunLogEntry[] = [];

    this.store.update((snapshot) => {
      const run = snapshot.runs.find((candidate) => candidate.runId === runId);
      if (!run) {
        return snapshot;
      }

      const task = snapshot.tasks.find((candidate) => candidate.taskId === run.taskId);
      const repo = snapshot.repos.find((candidate) => candidate.repoId === run.repoId);
      if (!task) {
        return snapshot;
      }

      const pendingEvents = run.pendingEvents.filter((event) => !(event.status === status && event.note === note));
      const nextRun: AgentRun = {
        ...run,
        status,
        pendingEvents,
        currentStepStartedAt: now,
        timeline: [...run.timeline, { status, at: now, note }]
      };

      if (status === 'PR_OPEN') {
        nextRun.prNumber = nextRun.prNumber ?? Math.floor((Date.now() / 1_000) % 10_000);
        nextRun.prUrl = nextRun.prUrl ?? `https://github.com/mock/${repo?.slug ?? run.repoId}/pull/${nextRun.prNumber}`;
        nextRun.headSha = nextRun.headSha ?? runId.slice(-7);
      }

      if (status === 'WAITING_PREVIEW') {
        nextRun.previewUrl = nextRun.previewUrl ?? `https://preview.example.invalid/${repo?.slug.replace('/', '-') ?? run.repoId}/${nextRun.prNumber ?? 0}`;
      }

      if (status === 'EVIDENCE_RUNNING' || status === 'DONE') {
        nextRun.artifactManifest = this.buildArtifactManifest(nextRun, task, repo?.baselineUrl);
        nextRun.artifacts = [
          nextRun.artifactManifest.logs.key,
          nextRun.artifactManifest.before?.key ?? '',
          nextRun.artifactManifest.after?.key ?? ''
        ].filter(Boolean);
      }

      if (status === 'FAILED' && note) {
        nextRun.errors = [...nextRun.errors, { at: now, message: note }];
        nextRun.endedAt = now;
      }

      if (status === 'DONE') {
        nextRun.endedAt = now;
      }

      generatedLogs = [...buildLogsForStatus(nextRun, status, now)];
      if (note && status === 'FAILED') {
        generatedLogs.push({ id: `${runId}_failed_note_${now}`, runId, createdAt: now, level: 'error', message: note });
      }

      const nextTask = this.deriveTask(run.taskId, snapshot.tasks, status, now, runId);
      return {
        ...snapshot,
        tasks: nextTask,
        runs: snapshot.runs.map((candidate) => (candidate.runId === runId ? nextRun : candidate)),
        logs: [...snapshot.logs, ...generatedLogs]
      };
    });

    const latest = this.store.getSnapshot().runs.find((candidate) => candidate.runId === runId);
    if (latest && !isTerminal(latest.status)) {
      this.scheduleRun(runId);
    } else {
      this.clearRunTimers(runId);
    }
  }

  private deriveTask(taskId: string, tasks: Task[], status: RunStatus, at: string, runId: string): Task[] {
    return tasks.map((task) => {
      if (task.taskId !== taskId) {
        return task;
      }

      let nextStatus = task.status;
      if (status === 'PR_OPEN' || status === 'WAITING_PREVIEW' || status === 'EVIDENCE_RUNNING' || status === 'DONE') {
        nextStatus = 'REVIEW';
      } else if (status === 'FAILED') {
        nextStatus = 'FAILED';
      } else if (!isTerminal(status)) {
        nextStatus = 'ACTIVE';
      }

      return {
        ...task,
        status: nextStatus,
        runId,
        updatedAt: at
      };
    });
  }

  private buildArtifactManifest(run: AgentRun, task: Task, repoBaseline?: string): ArtifactManifest {
    const baseKey = `runs/${run.runId}`;
    return {
      logs: { key: `${baseKey}/logs.txt`, label: 'Mock logs' },
      before: {
        key: `${baseKey}/before.png`,
        label: 'Before screenshot',
        url: getBaselineUrl(task, repoBaseline ? { repoId: '', slug: '', defaultBranch: '', baselineUrl: repoBaseline, enabled: true, createdAt: '', updatedAt: '' } : undefined)
      },
      after: {
        key: `${baseKey}/after.png`,
        label: 'After screenshot',
        url: run.previewUrl ?? 'https://preview.example.invalid/unavailable'
      },
      trace: {
        key: `${baseKey}/trace.zip`,
        label: 'Trace archive',
        url: `https://artifacts.example.invalid/${baseKey}/trace.zip`
      },
      video: {
        key: `${baseKey}/video.mp4`,
        label: 'Run video',
        url: `https://artifacts.example.invalid/${baseKey}/video.mp4`
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        simulatorVersion: 'phase-0',
        environmentId: 'mock-sandbox'
      }
    };
  }

  private clearRunTimers(runId: string) {
    for (const [key, timer] of this.timers.entries()) {
      if (key.startsWith(`${runId}:`)) {
        window.clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }
}
