import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import { createDailyBudgetSettingsStore } from '../dailyBudgetSettingsAdapter';
import { createDailyBudgetStateStore } from '../dailyBudgetStateAdapter';
import type { AppContext } from '../../lib/app/appContext';

/**
 * Constructs the {@link DailyBudgetService} with its collaborators resolved
 * from the app context, including the typed daily-budget settings store (config
 * keys) and state store (the `DAILY_BUDGET_STATE` blob) — together the sole
 * owners of the daily-budget `homey.settings` read/write, so the service itself
 * is SDK-free. The caller is responsible for the subsequent `loadSettings()` /
 * `loadState()` calls.
 */
export function createDailyBudgetService(ctx: AppContext): DailyBudgetService {
  return new DailyBudgetService({
    getTimeZone: () => ctx.getTimeZone(),
    log: (...args: unknown[]) => ctx.log(...args),
    isDebugTopicEnabled: (topic) => ctx.debugLoggingTopics.has(topic),
    getPowerTracker: () => ctx.powerTracker,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getCapacitySettings: () => ctx.capacitySettings,
    combinedPricesReader: ctx.combinedPricesReader,
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(ctx.homey),
    dailyBudgetStateStore: createDailyBudgetStateStore(ctx.homey),
    structuredLog: ctx.getStructuredLogger('daily_budget'),
    debugStructured: ctx.getStructuredDebugEmitter('daily_budget', 'daily_budget'),
  });
}
