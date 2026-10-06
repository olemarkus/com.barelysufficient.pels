import { describe, expect, it } from 'vitest';
import { hasCheaperEnergyHourAhead } from '../../lib/objectives/deferredObjectives/priceBand';
import type { DeferredObjectivePlannedBucket } from '../../lib/objectives/deferredObjectives/types';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const BASE_MS = Date.UTC(2026, 0, 1, 10, 0, 0);

const bucket = (
  startMs: number,
  endMs: number,
  overrides: Partial<DeferredObjectivePlannedBucket> = {},
): DeferredObjectivePlannedBucket => ({
  id: new Date(startMs).toISOString(),
  sourceBucketId: new Date(startMs).toISOString(),
  startMs,
  endMs,
  durationHours: (endMs - startMs) / HOUR_MS,
  price: 100,
  reserve: false,
  current: false,
  usefulEnergyCapacityKWh: 1,
  plannedUsefulEnergyKWh: 1,
  booked: true,
  ...overrides,
});

describe('hasCheaperEnergyHourAhead', () => {
  it('sees the next price hour in a fractional-offset timezone', () => {
    // UTC+5:30 price hours start at :30 UTC. Now is 11:10 UTC: the current segment
    // runs 11:10-11:30 and the next price hour starts at 11:30, inside the same UTC
    // hour. It is still a later hour.
    const current = bucket(BASE_MS + 70 * MINUTE_MS, BASE_MS + 90 * MINUTE_MS, { current: true });
    const next = bucket(BASE_MS + 90 * MINUTE_MS, BASE_MS + 150 * MINUTE_MS, { price: 50 });
    expect(hasCheaperEnergyHourAhead([current, next], current, 0.001)).toBe(true);
  });

  it('ignores a cheaper later bucket that is the deadline reserve or carries no booking', () => {
    const current = bucket(BASE_MS, BASE_MS + HOUR_MS, { current: true });
    const reserve = bucket(BASE_MS + HOUR_MS, BASE_MS + 2 * HOUR_MS, { price: 50, reserve: true });
    const unbooked = bucket(BASE_MS + 2 * HOUR_MS, BASE_MS + 3 * HOUR_MS, { price: 50, plannedUsefulEnergyKWh: 0 });
    expect(hasCheaperEnergyHourAhead([current, reserve, unbooked], current, 0.001)).toBe(false);
  });

  it('does not count an earlier or same-hour bucket as later', () => {
    const earlier = bucket(BASE_MS - HOUR_MS, BASE_MS, { price: 50 });
    const current = bucket(BASE_MS + 10 * MINUTE_MS, BASE_MS + HOUR_MS, { current: true });
    expect(hasCheaperEnergyHourAhead([earlier, current], current, 0.001)).toBe(false);
  });
});
