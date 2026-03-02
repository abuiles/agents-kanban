import type { RunStatus, ScheduledSimulationEvent, SimulationProfile } from '../domain/types';

const offsets: Record<Exclude<RunStatus, 'FAILED'>, number> = {
  QUEUED: 0,
  BOOTSTRAPPING: 1,
  RUNNING_CODEX: 3,
  OPERATOR_CONTROLLED: 4,
  RUNNING_TESTS: 8,
  PUSHING_BRANCH: 11,
  PR_OPEN: 13,
  WAITING_PREVIEW: 15,
  EVIDENCE_RUNNING: 19,
  DONE: 24
};

const happyPathStatuses: Array<Exclude<RunStatus, 'FAILED'>> = [
  'QUEUED',
  'BOOTSTRAPPING',
  'RUNNING_CODEX',
  'RUNNING_TESTS',
  'PUSHING_BRANCH',
  'PR_OPEN',
  'WAITING_PREVIEW',
  'EVIDENCE_RUNNING',
  'DONE'
];

export function buildSimulationPlan(startedAt: Date, profile: SimulationProfile): ScheduledSimulationEvent[] {
  const plan: ScheduledSimulationEvent[] = happyPathStatuses.map((status) => ({
    status,
    executeAt: new Date(startedAt.getTime() + offsets[status] * 1_000).toISOString()
  }));

  if (profile === 'fail_tests') {
    return plan
      .filter((event) => ['QUEUED', 'BOOTSTRAPPING', 'RUNNING_CODEX', 'RUNNING_TESTS'].includes(event.status))
      .concat({ status: 'FAILED', executeAt: new Date(startedAt.getTime() + 9_000).toISOString(), note: 'Mock tests failed during auth settings suite.' });
  }

  if (profile === 'fail_preview') {
    return plan
      .filter((event) => ['QUEUED', 'BOOTSTRAPPING', 'RUNNING_CODEX', 'RUNNING_TESTS', 'PUSHING_BRANCH', 'PR_OPEN', 'WAITING_PREVIEW'].includes(event.status))
      .concat({ status: 'FAILED', executeAt: new Date(startedAt.getTime() + 18_000).toISOString(), note: 'Preview never became ready before the mock timeout.' });
  }

  return plan;
}
