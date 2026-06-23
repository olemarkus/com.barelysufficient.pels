import { describe, expect, it } from 'vitest';
import { buildDayContext } from '../../packages/shared-domain/src/dailyBudget/dayContext';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';

describe('shared-domain buildDayContext', () => {
  it('floors legacy negative export buckets out of user-facing usage figures', () => {
    const nowMs = Date.UTC(2026, 0, 15, 12, 30, 0);
    const bucketKey = new Date(Date.UTC(2026, 0, 15, 12, 0, 0)).toISOString();
    const context = buildDayContext({
      nowMs,
      timeZone: 'UTC',
      powerTracker: {
        buckets: { [bucketKey]: -0.5 },
      } as PowerTrackerState,
    });

    expect(context.bucketUsage[12]).toBe(0);
    expect(context.currentBucketUsage).toBe(0);
    expect(context.usedNowKWh).toBe(0);
  });
});
