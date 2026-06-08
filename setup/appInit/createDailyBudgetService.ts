import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import { createDailyBudgetSettingsStore } from '../dailyBudgetSettingsAdapter';
import type { AppContext } from '../../lib/app/appContext';

/**
 * Constructs the {@link DailyBudgetService} with its collaborators resolved
 * from the app context, including the typed daily-budget settings store (the
 * sole owner of the config-key `homey.settings` read/write). The caller is
 * responsible for the subsequent `loadSettings()` / `loadState()` calls.
 */
export function createDailyBudgetService(ctx: AppContext): DailyBudgetService {
  return new DailyBudgetService({
    homey: ctx.homey,
    log: (...args: unknown[]) => ctx.log(...args),
    isDebugTopicEnabled: (topic) => ctx.debugLoggingTopics.has(topic),
    getPowerTracker: () => ctx.powerTracker,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getCapacitySettings: () => ctx.capacitySettings,
    combinedPricesReader: ctx.combinedPricesReader,
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(ctx.homey),
    structuredLog: ctx.getStructuredLogger('daily_budget'),
    debugStructured: ctx.getStructuredDebugEmitter('daily_budget', 'daily_budget'),
  });
}
