import { DailyBudgetManager } from '../lib/dailyBudget/dailyBudgetManager';
import { getDateKeyStartMs, getDateKeyInTimeZone } from '../lib/utils/dateUtils';
import type { PowerTrackerState } from '../lib/core/powerTracker';

const TZ = 'Europe/Oslo';

describe('daily budget history reproduction', () => {
  it('builds history without crashing', () => {
    const manager = new DailyBudgetManager({
      log: console.log,
      logDebug: console.log,
    });

    // Use a fixed "now" to keep the test deterministic.
    const nowMs = Date.UTC(2024, 0, 15, 12, 0, 0);
    const todayKey = getDateKeyInTimeZone(new Date(nowMs), TZ);
    const todayStartUtcMs = getDateKeyStartMs(todayKey, TZ);
    const yesterdayKey = getDateKeyInTimeZone(new Date(todayStartUtcMs - 12 * 60 * 60 * 1000), TZ);
    const yesterdayStartUtcMs = getDateKeyStartMs(yesterdayKey, TZ);
    const firstBucketKey = new Date(yesterdayStartUtcMs).toISOString();

    const powerTracker: PowerTrackerState = {
      buckets: { [firstBucketKey]: 1.2 },
      dailyBudgetCaps: { [firstBucketKey]: 1 },
    };

    const history = manager.buildHistory({
      dayStartUtcMs: yesterdayStartUtcMs,
      timeZone: TZ,
      powerTracker,
      combinedPrices: null,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });

    expect(history).not.toBeNull();
    expect(history?.dateKey).toBeDefined();
    expect(history?.buckets.plannedKWh.length).toBeGreaterThan(0);
    expect(history?.budget.enabled).toBe(true);
  });
});
