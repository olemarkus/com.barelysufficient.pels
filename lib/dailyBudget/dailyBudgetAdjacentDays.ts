import type { PowerTrackerState } from '../power/tracker';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
} from '../utils/dateUtils';
import { readCombinedPriceData } from '../price/priceStore';
import type { CombinedPricesReader } from '../price/combinedPricesReader';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger } from '../logging/logger';
import { getLogger } from '../logging/logger';
import type { DailyBudgetManager } from './dailyBudgetManager';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

const moduleLogger = getLogger('dailyBudget/service');

/**
 * Collaborators the adjacent-day (tomorrow preview / yesterday history) builders need from
 * `DailyBudgetService`. Bundled so the forecast computation lives outside the service body
 * (keeping it under the 500-LOC floor) without each builder growing a long positional param list.
 */
export type DailyBudgetAdjacentDayDeps = {
  resolveTimeZone: () => string;
  combinedPricesReader: CombinedPricesReader;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  structuredLog?: PinoLogger;
};

export const buildTomorrowPreview = (
  deps: DailyBudgetAdjacentDayDeps,
  nowMs: number,
  manager: DailyBudgetManager,
  settings: DailyBudgetSettings,
): DailyBudgetDayPayload | null => {
  try {
    const timeZone = deps.resolveTimeZone();
    const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
    const todayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
    const tomorrowStartUtcMs = getNextLocalDayStartUtcMs(todayStartUtcMs, timeZone);
    const combinedPrices = readCombinedPriceData(deps.combinedPricesReader, new Date(nowMs), timeZone);
    const capacityBudgetKWh = resolveUsableCapacityKw(deps.getCapacitySettings());
    return manager.buildPreview({
      dayStartUtcMs: tomorrowStartUtcMs,
      timeZone,
      settings,
      combinedPrices,
      priceOptimizationEnabled: deps.getPriceOptimizationEnabled(),
      capacityBudgetKWh,
    });
  } catch (error) {
    (deps.structuredLog ?? moduleLogger).error({
      event: 'daily_budget_tomorrow_preview_failed',
      err: normalizeError(error),
    });
    return null;
  }
};

const resolveYesterdayContext = (
  deps: DailyBudgetAdjacentDayDeps,
  nowMs: number,
): { timeZone: string; yesterdayStartUtcMs: number } | null => {
  try {
    const timeZone = deps.resolveTimeZone();
    const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
    const yesterdayKey = shiftDateKey(todayKey, -1);
    const yesterdayStartUtcMs = getDateKeyStartMs(yesterdayKey, timeZone);
    return { timeZone, yesterdayStartUtcMs };
  } catch (error) {
    (deps.structuredLog ?? moduleLogger).error({
      event: 'daily_budget_yesterday_date_resolve_failed',
      err: normalizeError(error),
    });
    return null;
  }
};

export const buildYesterdayHistory = (
  deps: DailyBudgetAdjacentDayDeps,
  nowMs: number,
  manager: DailyBudgetManager,
  settings: DailyBudgetSettings,
): DailyBudgetDayPayload | null => {
  const context = resolveYesterdayContext(deps, nowMs);
  if (!context) return null;
  const { timeZone, yesterdayStartUtcMs } = context;
  try {
    const combinedPrices = readCombinedPriceData(deps.combinedPricesReader, new Date(nowMs), timeZone);
    return manager.buildHistory({
      dayStartUtcMs: yesterdayStartUtcMs,
      timeZone,
      powerTracker: deps.getPowerTracker(),
      combinedPrices,
      priceOptimizationEnabled: deps.getPriceOptimizationEnabled(),
      priceShapingEnabled: settings.priceShapingEnabled,
      controlledUsageWeight: settings.controlledUsageWeight,
    });
  } catch (error) {
    (deps.structuredLog ?? moduleLogger).error({
      event: 'daily_budget_yesterday_history_failed',
      err: normalizeError(error),
    });
    return null;
  }
};
