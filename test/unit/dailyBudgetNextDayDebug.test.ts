import { buildDefaultProfile } from '../../lib/dailyBudget/dailyBudgetManager';
import { logNextDayPlanDebug } from '../../lib/dailyBudget/dailyBudgetNextDayDebug';
import { buildDayContext } from '../../lib/dailyBudget/dailyBudgetState';
import { getNextLocalDayStartUtcMs } from '../../lib/utils/dateUtils';

const TZ = 'Europe/Oslo';

describe('daily budget next-day debug', () => {
  it('logs effective price shaping flex share for next-day plan debug', () => {
    const debugStructured = vi.fn();
    const nowMs = Date.UTC(2024, 0, 15, 11, 0);
    const context = buildDayContext({
      nowMs,
      timeZone: TZ,
      powerTracker: { buckets: {} },
    });
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: true,
      controlledUsageWeight: 0.3,
      priceShapingFlexShare: 0.5,
    };
    const nextDayStartUtcMs = getNextLocalDayStartUtcMs(context.dayStartUtcMs, TZ);
    const combinedPrices = {
      prices: Array.from({ length: 24 }, (_, index) => ({
        startsAt: new Date(nextDayStartUtcMs + index * 60 * 60 * 1000).toISOString(),
        total: 100 + index * 20,
      })),
    };

    logNextDayPlanDebug({
      debugStructured,
      shouldLog: true,
      context,
      settings,
      state: {},
      combinedPrices,
      priceOptimizationEnabled: true,
      defaultProfile: buildDefaultProfile(),
    });

    const debugCall = debugStructured.mock.calls.find((call) => (
      typeof call[0] === 'object'
      && call[0] !== null
      && call[0].event === 'daily_budget_plan_debug'
      && call[0].variant === 'next_day'
    ));
    expect(debugCall).toBeDefined();
    const payload = debugCall?.[0] as { meta: { priceSpreadFactor: number; effectivePriceShapingFlexShare: number } };
    expect(typeof payload.meta.priceSpreadFactor).toBe('number');
    expect(typeof payload.meta.effectivePriceShapingFlexShare).toBe('number');
    expect(payload.meta.priceSpreadFactor).toBeGreaterThan(0);
    expect(payload.meta.effectivePriceShapingFlexShare).toBeCloseTo(settings.priceShapingFlexShare, 6);
  });
});
