import { buildDefaultProfile } from '../lib/dailyBudget/dailyBudgetManager';
import { logNextDayPlanDebug } from '../lib/dailyBudget/dailyBudgetNextDayDebug';
import { buildDayContext } from '../lib/dailyBudget/dailyBudgetState';
import { getNextLocalDayStartUtcMs } from '../lib/utils/dateUtils';

const TZ = 'Europe/Oslo';

describe('daily budget next-day debug', () => {
  it('logs effective price shaping flex share for next-day plan debug', () => {
    const logDebug = jest.fn();
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
      logDebug,
      shouldLog: true,
      context,
      settings,
      state: {},
      combinedPrices,
      priceOptimizationEnabled: true,
      defaultProfile: buildDefaultProfile(),
    });

    const debugCall = logDebug.mock.calls.find((call) => (
      typeof call[0] === 'string'
      && call[0].startsWith('Daily budget: plan debug (next day) ')
    ));
    expect(debugCall).toBeDefined();
    const payload = JSON.parse(
      (debugCall?.[0] as string).replace('Daily budget: plan debug (next day) ', ''),
    );
    expect(typeof payload.meta.priceSpreadFactor).toBe('number');
    expect(typeof payload.meta.effectivePriceShapingFlexShare).toBe('number');
    expect(payload.meta.effectivePriceShapingFlexShare).toBeCloseTo(
      settings.priceShapingFlexShare * payload.meta.priceSpreadFactor,
      6,
    );
  });
});
