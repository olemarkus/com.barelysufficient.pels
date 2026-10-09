import { buildDefaultProfile, DailyBudgetManager } from '../../lib/dailyBudget/dailyBudgetManager';
import { logNextDayPlanDebug } from '../../lib/dailyBudget/dailyBudgetNextDayDebug';
import { ensureDailyBudgetProfile } from '../../lib/dailyBudget/dailyBudgetProfile';
import { buildDayContext } from '../../lib/dailyBudget/dailyBudgetState';
import type { DailyBudgetDayPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { getNextLocalDayStartUtcMs } from '../../packages/shared-domain/src/utils/dateUtils';
import { observedHourlyStatsFixture } from '../helpers/observedHourlyStatsFixture';

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
      planningCeiling: null,
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

  it('plans the next-day gross background from the learned gross series, as the next-day preview does', () => {
    const debugStructured = vi.fn();
    const nowMs = Date.UTC(2024, 0, 15, 11, 0);
    const context = buildDayContext({ nowMs, timeZone: TZ, powerTracker: { buckets: {} } });
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
      controlledUsageWeight: 0.3,
      priceShapingFlexShare: 0.5,
    };
    const defaultProfile = buildDefaultProfile();
    const hourly = (value: number) => Array.from({ length: 24 }, () => value);
    // Net and gross background are deliberately far apart, so a plan that drops
    // the gross series and falls back to the net line cannot pass for one that
    // uses it.
    const { state } = ensureDailyBudgetProfile({
      ...observedHourlyStatsFixture({
        profileObservedP50UncontrolledKWh: hourly(0.1),
        profileObservedP75UncontrolledKWh: hourly(0.15),
        profileObservedP90UncontrolledKWh: hourly(0.2),
        profileObservedUncontrolledSampleCounts: hourly(30),
        profileObservedP50GrossUncontrolledKWh: hourly(0.8),
        profileObservedP75GrossUncontrolledKWh: hourly(0.9),
        profileObservedP90GrossUncontrolledKWh: hourly(1),
        profileObservedGrossUncontrolledSampleCounts: hourly(30),
      }),
    }, defaultProfile);

    logNextDayPlanDebug({
      debugStructured,
      shouldLog: true,
      context,
      settings,
      state,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      planningCeiling: null,
      defaultProfile,
    });
    const debugCall = debugStructured.mock.calls.find((call) => (
      typeof call[0] === 'object'
      && call[0] !== null
      && call[0].event === 'daily_budget_plan_debug'
      && call[0].variant === 'next_day'
    ));
    const logged = (debugCall?.[0] as DailyBudgetDayPayload | undefined)?.buckets;

    const manager = new DailyBudgetManager({ log: () => undefined });
    manager.loadState(state);
    const preview = manager.buildPreview({
      dayStartUtcMs: getNextLocalDayStartUtcMs(context.dayStartUtcMs, TZ),
      timeZone: TZ,
      settings,
      combinedPrices: null,
      priceOptimizationEnabled: false,
      planningCeiling: null,
    }).buckets;

    expect(logged?.plannedGrossUncontrolledKWh).toHaveLength(24);
    expect(logged?.plannedGrossUncontrolledKWh).toEqual(preview.plannedGrossUncontrolledKWh);
    expect(logged?.plannedGrossUncontrolledKWh).not.toEqual(logged?.plannedUncontrolledKWh);
    for (const grossKWh of logged?.plannedGrossUncontrolledKWh ?? []) {
      expect(grossKWh).toBeGreaterThanOrEqual(0.8);
    }
  });
});
