import { describe, expect, it } from 'vitest';
import { collectLifecycleMilestonesFromStatuses, mapRunStatusToLifecycleMilestone, truncateFeedbackText } from './timeline';

describe('slack timeline lifecycle mapping', () => {
  it('maps run statuses to milestones in low-noise order', () => {
    const milestones = collectLifecycleMilestonesFromStatuses([
      'QUEUED',
      'QUEUED',
      'BOOTSTRAPPING',
      'RUNNING_CODEX',
      'RUNNING_TESTS',
      'PUSHING_BRANCH',
      'PR_OPEN',
      'WAITING_PREVIEW',
      'EVIDENCE_RUNNING',
      'DONE'
    ]);

    expect(milestones).toEqual(['queued', 'running', 'mr_open', 'done']);
  });

  it('maps failure status to failed milestone', () => {
    expect(mapRunStatusToLifecycleMilestone('FAILED')).toBe('failed');
  });

  it('truncates feedback notes for concise Slack output', () => {
    const long = 'x'.repeat(500);
    const truncated = truncateFeedbackText(long);
    expect(truncated.length).toBeLessThanOrEqual(220);
    expect(truncated.endsWith('...')).toBe(true);
  });
});
