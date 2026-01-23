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

    const nowMs = Date.now();
    const todayKey = getDateKeyInTimeZone(new Date(nowMs), TZ);
    const todayStartUtcMs = getDateKeyStartMs(todayKey, TZ);

    // Go back 24 hours
    const yesterdayStartUtcMs = todayStartUtcMs - 24 * 60 * 60 * 1000;

    const powerTracker: PowerTrackerState = {
      buckets: {},
      dailyBudgetCaps: {},
    };

    const history = manager.buildHistory({
      dayStartUtcMs: yesterdayStartUtcMs,
      timeZone: TZ,
      powerTracker,
      combinedPrices: null,
      priceOptimizationEnabled: true,
      priceShapingEnabled: true,
    });

    expect(history).toBeDefined();
    expect(history.dateKey).toBeDefined();
    expect(history.buckets.plannedKWh.length).toBeGreaterThan(0);
    // If dailyBudgetCaps is empty, enabled should be false
    expect(history.budget.enabled).toBe(false);
  });
});
