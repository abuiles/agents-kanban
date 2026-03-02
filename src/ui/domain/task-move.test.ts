import { describe, expect, it } from 'vitest';
import { canMoveTaskToStatus } from './task-move';

describe('canMoveTaskToStatus', () => {
  it('blocks moving an active task away while its run is still active', () => {
    expect(canMoveTaskToStatus('ACTIVE', 'WAITING_PREVIEW', 'DONE')).toBe(false);
  });

  it('allows moving a review task to done even if its run is still in review lifecycle', () => {
    expect(canMoveTaskToStatus('REVIEW', 'WAITING_PREVIEW', 'DONE')).toBe(true);
  });

  it('allows moving any task when the latest run is terminal', () => {
    expect(canMoveTaskToStatus('REVIEW', 'DONE', 'DONE')).toBe(true);
  });
});
