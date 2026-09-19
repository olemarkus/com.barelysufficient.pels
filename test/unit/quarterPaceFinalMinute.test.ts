import { computeDynamicSoftLimit } from '../../lib/plan/planBudget';

describe('computeDynamicSoftLimit in a quarter', () => {
  it('does not understate the pace in the final seconds of a quarter', () => {
    // SHS 2026-09-19: a quarter running at 4.58 kW under a 4.8 kW pace, 12 s
    // before its boundary. A one-minute divisor floor read the 0.07 kWh left as
    // 4.21 kW and shed a thermostat for nothing.
    const quarterStartMs = Date.UTC(2025, 0, 15, 12, 0);
    const capacitySettings = { limitKw: 5, marginKw: 0.2, periodMinutes: 15 } as const;
    const pace = (elapsedS: number, energyKWh: number) => {
      const nowMs = quarterStartMs + elapsedS * 1000;
      return computeDynamicSoftLimit(
        capacitySettings,
        {
          lastTimestamp: nowMs,
          capacityQuarter: { startMs: quarterStartMs, energyKWh, trackedMs: nowMs - quarterStartMs },
        },
        nowMs,
      );
    };

    expect(pace(888, 4.58 * (888 / 3600)).allowedKw).toBeCloseTo(4.8, 6);
    // A quarter that genuinely overspent late is still held back honestly:
    // 0.01 kWh left over the last 12 s is a 3 kW pace.
    expect(pace(888, 1.19).allowedKw).toBeCloseTo(0.01 / (12 / 3600), 6);
  });
});
