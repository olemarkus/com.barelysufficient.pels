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

  it('allows burst rate even in last minutes (no EOH capping)', () => {
    const bucketStartMs = 0;
    const bucketEndMs = 60 * 60 * 1000;
    const nowMs = bucketEndMs - 5 * 60 * 1000; // 5 minutes remaining
    const allowed = computeDailyUsageSoftLimit({
      plannedKWh: 4,
      usedKWh: 1,
      bucketStartMs,
      bucketEndMs,
      nowMs,
    });
    // Remaining: 3 kWh over 5 minutes (but uses min threshold of 10 minutes)
    // remainingHours = max(5/60, 10/60) = 10/60 = 0.1667 hours
    // Burst rate: 3 / 0.1667 = 18 kW
    // Daily budget NEVER applies EOH capping (unlike hourly capacity)
    expect(allowed).toBeCloseTo(18, 0);
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
