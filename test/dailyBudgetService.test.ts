import { DailyBudgetService } from '../lib/dailyBudget/dailyBudgetService';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from '../lib/dailyBudget/dailyBudgetConstants';
import { DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH } from '../lib/utils/settingsKeys';
import { MockSettings } from './mocks/homey';

const buildService = () => {
  const settings = new MockSettings();
  const log = jest.fn();
  const logDebug = jest.fn();
  const homey = {
    settings,
    clock: {
      getTimezone: () => 'Europe/Oslo',
    },
  } as any;

  const service = new DailyBudgetService({
    homey,
    log,
    logDebug,
    getPowerTracker: () => ({}) as any,
    getPriceOptimizationEnabled: () => false,
    getCapacitySettings: () => ({ limitKw: 0, marginKw: 0 }),
  });

  return { service, settings, logDebug };
};

describe('DailyBudgetService', () => {
  test('setDynamicBudget clamps values and logs changes', () => {
    const { service, settings, logDebug } = buildService();
    settings.set(DAILY_BUDGET_ENABLED, true);
    settings.set(DAILY_BUDGET_KWH, 10);
    service.loadSettings();

    service.setDynamicBudget(MAX_DAILY_BUDGET_KWH * 10);
    expect((service as any).dynamicBudgetKWh).toBe(MAX_DAILY_BUDGET_KWH);

    service.setDynamicBudget(MIN_DAILY_BUDGET_KWH / 10);
    expect((service as any).dynamicBudgetKWh).toBe(MIN_DAILY_BUDGET_KWH);

    expect(logDebug).toHaveBeenCalled();
  });

  test('clearDynamicBudget resets dynamic budget', () => {
    const { service, settings, logDebug } = buildService();
    settings.set(DAILY_BUDGET_ENABLED, true);
    settings.set(DAILY_BUDGET_KWH, 10);
    service.loadSettings();

    service.setDynamicBudget(20);
    service.clearDynamicBudget();

    expect((service as any).dynamicBudgetKWh).toBeNull();
    expect(logDebug).toHaveBeenCalled();
  });
});
