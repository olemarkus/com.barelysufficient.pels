import type { PowerTrackerState } from '../power/tracker';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger } from '../logging/logger';
import { getLogger } from '../logging/logger';
import type { DailyBudgetManager } from './dailyBudgetManager';
import type { DailyBudgetPlanInputs } from './dailyBudgetManagerTypes';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

const moduleLogger = getLogger('dailyBudget/service');

/**
 * Collaborators the adjacent-day (tomorrow preview / yesterday history) builders need from
 * `DailyBudgetService`. Bundled so the forecast computation lives outside the service body
 * (keeping it under the 500-LOC floor) without each builder growing a long positional param list.
 * The prices, price switch and ceiling are not read here: each builder takes the update's one
 * read of them (`DailyBudgetPlanInputs`).
 */
export type DailyBudgetAdjacentDayDeps = {
  resolveTimeZone: () => string;
  getPowerTracker: () => PowerTrackerState;
  structuredLog?: PinoLogger;
};

export const buildTomorrowPreview = (
  deps: DailyBudgetAdjacentDayDeps,
  nowMs: number,
  inputs: DailyBudgetPlanInputs,
  manager: DailyBudgetManager,
  settings: DailyBudgetSettings,
): DailyBudgetDayPayload | null => {
  try {
    const timeZone = deps.resolveTimeZone();
    const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
    const todayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
    const tomorrowStartUtcMs = getNextLocalDayStartUtcMs(todayStartUtcMs, timeZone);
    return manager.buildPreview({
      dayStartUtcMs: tomorrowStartUtcMs,
      timeZone,
      settings,
      ...inputs,
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
  inputs: DailyBudgetPlanInputs,
  manager: DailyBudgetManager,
  settings: DailyBudgetSettings,
): DailyBudgetDayPayload | null => {
  const context = resolveYesterdayContext(deps, nowMs);
  if (!context) return null;
  const { timeZone, yesterdayStartUtcMs } = context;
  try {
    return manager.buildHistory({
      dayStartUtcMs: yesterdayStartUtcMs,
      timeZone,
      powerTracker: deps.getPowerTracker(),
      ...inputs,
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
