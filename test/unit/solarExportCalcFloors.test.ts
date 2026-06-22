// Unit coverage for the solar-export calculation floors + the exempt gross-up.
// Under solar export the net grid signal goes negative; these readers must not let
// negative kWh corrupt billed/usage/cost figures, and exempt attribution must use
// gross (not net) so it doesn't leak into the managed bucket.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';
import { getCurrentMonthUsageKwh } from '../../lib/price/priceServiceNorgespris';
import { getCurrentHourContext } from '../../lib/plan/planHourContext';
import { recordPowerSample } from '../../lib/power/tracker';
import { buildBucketUsage } from '../../lib/dailyBudget/dailyBudgetState';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

describe('solar-export calculation floors', () => {
  it('resolveDailyKwh floors negative export hours out of the day total', () => {
    const out = resolveDailyKwh({
      dateKey: '2026-01-15',
      timeZone: 'UTC',
      source: {
        buckets: {
          '2026-01-15T12:00:00.000Z': -0.5, // export hour
          '2026-01-15T13:00:00.000Z': 1.0,
        },
      },
    });
    // RED today: -0.5 + 1.0 = 0.5. GREEN: export hour floored -> 1.0.
    expect(out.total).toBe(1.0);
  });

  it('getCurrentHourContext floors a negative current-hour bucket', () => {
    const nowMs = Date.UTC(2026, 0, 15, 12, 30, 0);
    const bucketKey = new Date(Date.UTC(2026, 0, 15, 12, 0, 0)).toISOString();
    const tracker = { buckets: { [bucketKey]: -0.3 } } as unknown as PowerTrackerState;
    const ctx = getCurrentHourContext(tracker, nowMs);
    expect(ctx.usedKWh).toBeGreaterThanOrEqual(0); // RED: -0.3
  });

  it('getCurrentMonthUsageKwh floors negative export hours out of month usage', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    const homey = {
      settings: {
        get: (key: string) => (key === 'power_tracker_state'
          ? { buckets: { '2026-01-10T12:00:00.000Z': -0.5, '2026-01-11T12:00:00.000Z': 2.0 } }
          : undefined),
      },
    };
    expect(getCurrentMonthUsageKwh(homey, 'UTC')).toBe(2.0); // RED: 1.5
  });

  it('buildBucketUsage floors a negative export hour out of the metered reporting figures', () => {
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    const iso = new Date(ts).toISOString();
    const res = buildBucketUsage({
      bucketStartUtcMs: [ts],
      powerTracker: { buckets: { [iso]: -0.5 } } as unknown as PowerTrackerState,
    });
    expect(res.bucketUsage[0]).toBe(0); // RED: -0.5 deflates metered/remaining/exceeded/projection
  });

  it('recordPowerSample bounds exempt usage by GROSS consumption, not net (no managed leak under solar)', async () => {
    let saved: PowerTrackerState | undefined;
    await recordPowerSample({
      state: {} as PowerTrackerState,
      currentPowerW: 500, // net grid import (solar self-consuming)
      grossConsumptionW: 3000, // net + generation = actual consumption
      controlledPowerW: 2500,
      exemptPowerW: 2000, // a budget-exempt managed device drawing 2 kW (gross)
      nowMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      hourBudgetKWh: 5,
      rebuildPlanFromCache: async () => {},
      saveState: (s) => { saved = s; },
    });
    // RED today: exempt clamped to net 500. GREEN: bounded by gross -> 2000.
    expect(saved?.lastExemptPowerW).toBe(2000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
