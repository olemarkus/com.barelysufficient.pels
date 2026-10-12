import { DailyBudgetManager } from '../../lib/dailyBudget/dailyBudgetManager';
import type { DailyBudgetPlanInputs } from '../../lib/dailyBudget/dailyBudgetManagerTypes';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../lib/logging/logger';

const TZ = 'Europe/Oslo';
// 2024-01-16 00:00 in Oslo (CET, UTC+1).
const TOMORROW_START_UTC_MS = Date.UTC(2024, 0, 15, 23, 0);
const HOUR_MS = 60 * 60 * 1000;

const SETTINGS: DailyBudgetSettings = {
  enabled: true,
  dailyBudgetKWh: 10,
  priceShapingEnabled: true,
  controlledUsageWeight: 0.3,
  priceShapingFlexShare: 0.5,
};

const INPUTS: DailyBudgetPlanInputs = {
  combinedPrices: {
    prices: Array.from({ length: 24 }, (_, index) => ({
      startsAt: new Date(TOMORROW_START_UTC_MS + index * HOUR_MS).toISOString(),
      total: 100 + index * 20,
    })),
  },
  priceOptimizationEnabled: true,
  planningCeiling: null,
};

const buildManager = (isDebugTopicEnabled = true) => {
  const debugStructured = vi.fn<StructuredDebugEmitter>();
  const manager = new DailyBudgetManager({
    log: () => undefined,
    isDebugTopicEnabled: () => isDebugTopicEnabled,
    debugStructured,
  });
  return { manager, debugStructured };
};

const buildTomorrowPreview = (manager: DailyBudgetManager, settings: DailyBudgetSettings) => manager.buildPreview({
  dayStartUtcMs: TOMORROW_START_UTC_MS,
  timeZone: TZ,
  settings,
  ...INPUTS,
});

const nextDayEntries = (debugStructured: ReturnType<typeof vi.fn<StructuredDebugEmitter>>) => (
  debugStructured.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.event === 'daily_budget_plan_debug' && payload.variant === 'next_day')
);

describe('daily budget next-day debug', () => {
  it('writes the preview it is given, with the spread and effective flex share of its prices', () => {
    const { manager, debugStructured } = buildManager();
    const preview = buildTomorrowPreview(manager, SETTINGS);

    manager.logNextDayPlan(preview, SETTINGS, INPUTS);

    const [entry, ...extra] = nextDayEntries(debugStructured);
    expect(extra).toHaveLength(0);
    const payload = entry as DailyBudgetDayPayload & {
      meta: {
        priceSpreadFactor: number;
        effectivePriceShapingFlexShare: number;
        planningCeiling: unknown;
        planDebug: unknown;
        settings: { dailyBudgetKWh: number };
      };
    };
    expect(payload.dateKey).toBe(preview.dateKey);
    expect(payload.buckets).toEqual(preview.buckets);
    expect(payload.meta.priceSpreadFactor).toBeGreaterThan(0);
    expect(payload.meta.effectivePriceShapingFlexShare).toBeCloseTo(SETTINGS.priceShapingFlexShare, 6);
    expect(payload.meta.settings.dailyBudgetKWh).toBe(SETTINGS.dailyBudgetKWh);
    expect(payload.meta.planningCeiling).toBeNull();
    expect(payload.meta.planDebug).toEqual({
      lockCurrentBucket: false,
      shouldLockCurrent: false,
      remainingStartIndex: 0,
      hasPreviousPlan: false,
    });
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({ event: 'daily_budget_profile_samples' }));
  });

  it.each([
    ['the budget is off', { ...SETTINGS, enabled: false }, true],
    ['the budget is 0 kWh', { ...SETTINGS, dailyBudgetKWh: 0 }, true],
    ['the daily_budget topic is off', SETTINGS, false],
  ])('writes nothing when %s', (_label, settings, topicEnabled) => {
    const { manager, debugStructured } = buildManager(topicEnabled);
    const preview = buildTomorrowPreview(manager, SETTINGS);

    manager.logNextDayPlan(preview, settings, INPUTS);

    expect(debugStructured).not.toHaveBeenCalled();
  });
});
