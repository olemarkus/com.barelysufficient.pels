import type Homey from 'homey';
import type { PowerTrackerState } from '../power/tracker';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
} from '../utils/dateUtils';
import { readCombinedPriceData } from '../price/priceStore';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import type { DailyBudgetManager } from './dailyBudgetManager';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

/**
 * Collaborators the adjacent-day (tomorrow preview / yesterday history) builders need from
 * `DailyBudgetService`. Bundled so the forecast computation lives outside the service body
 * (keeping it under the 500-LOC floor) without each builder growing a long positional param list.
 */
export type DailyBudgetAdjacentDayDeps = {
  resolveTimeZone: () => string;
  priceStoreDeps: { homey: Homey.App['homey']; requestRefetch: () => void };
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  logError: (message: string, error: unknown) => void;
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
    const combinedPrices = readCombinedPriceData(deps.priceStoreDeps, new Date(nowMs), timeZone);
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
    deps.logError('Daily budget: failed to build tomorrow preview', error);
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
    deps.logError('Daily budget: failed to resolve yesterday date', error);
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
    const combinedPrices = readCombinedPriceData(deps.priceStoreDeps, new Date(nowMs), timeZone);
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
    deps.logError('Daily budget: failed to build yesterday history', error);
    return null;
  }
};
