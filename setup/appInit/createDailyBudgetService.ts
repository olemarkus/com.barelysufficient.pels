import { DailyBudgetService } from '../../lib/dailyBudget/dailyBudgetService';
import { createDailyBudgetSettingsStore } from '../dailyBudgetSettingsAdapter';
import {
  createDailyBudgetStateStore,
  importLegacyDailyBudgetState,
  type DailyBudgetStateStore,
} from '../../lib/dailyBudget/dailyBudgetStateStore';
import type { AppContext } from '../../lib/app/appContext';
import { requirePriceCoordinator } from './contextGuards';

/**
 * The daily budget's state repository on the app's userdata database, with the
 * one-shot import of the legacy settings blob run before the service reads it.
 */
const createDailyBudgetStateStoreForApp = (ctx: AppContext): DailyBudgetStateStore => {
  const store = createDailyBudgetStateStore(ctx.getUserdataDatabase());
  importLegacyDailyBudgetState(ctx.homey.settings, store);
  return store;
};

/**
 * Constructs the {@link DailyBudgetService} with its collaborators resolved
 * from the app context, including the typed daily-budget settings store (the
 * config keys in `homey.settings`) and state store (the plan and learned
 * profiles in the userdata store), so the service itself is SDK-free. The
 * caller is responsible for the subsequent `loadSettings()` / `loadState()`
 * calls.
 */
export function createDailyBudgetService(ctx: AppContext): DailyBudgetService {
  return new DailyBudgetService({
    getTimeZone: () => ctx.getTimeZone(),
    log: (...args: unknown[]) => ctx.log(...args),
    isDebugTopicEnabled: (topic) => ctx.debugLoggingTopics.has(topic),
    getPowerTracker: () => ctx.powerTracker,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getCapacitySettings: () => ctx.capacitySettings,
    combinedPricesReader: requirePriceCoordinator(ctx).combinedPricesReader,
    dailyBudgetSettingsStore: createDailyBudgetSettingsStore(ctx.homey),
    dailyBudgetStateStore: createDailyBudgetStateStoreForApp(ctx),
    structuredLog: ctx.getStructuredLogger('daily_budget'),
    debugStructured: ctx.getStructuredDebugEmitter('daily_budget', 'daily_budget'),
  });
}
