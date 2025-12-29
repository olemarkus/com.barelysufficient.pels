import { computeDailyUsageSoftLimit } from '../lib/plan/planBudget';

describe('daily usage soft limit', () => {
  it('uses remaining planned kWh over remaining hour', () => {
    const bucketStartMs = 0;
    const bucketEndMs = 60 * 60 * 1000;
    const nowMs = 30 * 60 * 1000;
    const allowed = computeDailyUsageSoftLimit({
      plannedKWh: 4,
      usedKWh: 1,
      bucketStartMs,
      bucketEndMs,
      nowMs,
    });
    expect(allowed).toBeCloseTo(6, 3);
  });

  it('caps burst rate in the last 10 minutes', () => {
    const bucketStartMs = 0;
    const bucketEndMs = 60 * 60 * 1000;
    const nowMs = bucketEndMs - 5 * 60 * 1000;
    const allowed = computeDailyUsageSoftLimit({
      plannedKWh: 4,
      usedKWh: 1,
      bucketStartMs,
      bucketEndMs,
      nowMs,
    });
    expect(allowed).toBeCloseTo(4, 3);
  });

  it('returns 0 when the planned budget is 0', () => {
    const allowed = computeDailyUsageSoftLimit({
      plannedKWh: 0,
      usedKWh: 0,
      bucketStartMs: 0,
      bucketEndMs: 60 * 60 * 1000,
      nowMs: 0,
    });
    expect(allowed).toBe(0);
  });
});
