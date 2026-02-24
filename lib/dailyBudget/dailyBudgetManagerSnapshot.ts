import { buildPlanBreakdown } from './dailyBudgetBreakdown';
import { buildDailyBudgetSnapshot, type BudgetState, type DayContext, type PriceData } from './dailyBudgetState';
import { getEffectiveProfileData } from './dailyBudgetProfile';
import { logDailyBudgetPlanDebug } from './dailyBudgetManagerPlan';
import type {
  DailyBudgetDayPayload,
  DailyBudgetSettings,
  DailyBudgetState,
} from './dailyBudgetTypes';
import type { PlanResult } from './dailyBudgetManagerTypes';

export function logBudgetSummaryIfNeeded(params: {
  logDebug: (...args: unknown[]) => void;
  shouldLog: boolean;
  context: DayContext;
  budget: BudgetState;
}): void {
  const { logDebug, shouldLog, context, budget } = params;
  if (!shouldLog) return;
  logDebug(
    `Daily budget: used ${context.usedNowKWh.toFixed(2)} kWh, `
    + `allowed ${budget.allowedNowKWh.toFixed(2)} kWh, `
    + `remaining ${budget.remainingKWh.toFixed(2)} kWh, `
    + `confidence ${budget.confidence.toFixed(2)}`,
  );
}

export function buildSnapshot(params: {
  state: DailyBudgetState;
  settings: DailyBudgetSettings;
  enabled: boolean;
  plan: PlanResult;
  budget: BudgetState;
  context: DayContext;
  defaultProfile: number[];
}): DailyBudgetDayPayload {
  const {
    state,
    settings,
    enabled,
    plan,
    budget,
    context,
    defaultProfile,
  } = params;
  const profileData = getEffectiveProfileData(state, settings, defaultProfile);
  const hasPlannedBreakdown = Array.isArray(plan.plannedUncontrolledKWh)
    && Array.isArray(plan.plannedControlledKWh)
    && plan.plannedUncontrolledKWh.length === plan.plannedKWh.length
    && plan.plannedControlledKWh.length === plan.plannedKWh.length;
  const breakdown = hasPlannedBreakdown
    ? {
      plannedUncontrolledKWh: plan.plannedUncontrolledKWh as number[],
      plannedControlledKWh: plan.plannedControlledKWh as number[],
    }
    : buildPlanBreakdown({
      bucketStartUtcMs: context.bucketStartUtcMs,
      timeZone: context.timeZone,
      plannedKWh: plan.plannedKWh,
      breakdown: profileData.breakdown,
    });
  return buildDailyBudgetSnapshot({
    context,
    settings,
    enabled,
    plannedKWh: plan.plannedKWh,
    plannedUncontrolledKWh: breakdown?.plannedUncontrolledKWh,
    plannedControlledKWh: breakdown?.plannedControlledKWh,
    priceData: plan.priceData,
    budget,
    frozen: Boolean(state.frozen),
  });
}

export function logPlanDebugIfNeeded(params: {
  logDebug: (...args: unknown[]) => void;
  shouldLog: boolean;
  snapshot: DailyBudgetDayPayload;
  priceData: PriceData;
  priceOptimizationEnabled: boolean;
  capacityBudgetKWh?: number;
  settings: DailyBudgetSettings;
  state: DailyBudgetState;
  defaultProfile: number[];
  label?: string;
  planDebug?: {
    lockCurrentBucket: boolean;
    shouldLockCurrent: boolean;
    remainingStartIndex: number;
    hasPreviousPlan: boolean;
  };
}): void {
  const {
    logDebug,
    shouldLog,
    snapshot,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    label,
    planDebug,
  } = params;
  if (!shouldLog) return;
  logDailyBudgetPlanDebug({
    logDebug,
    snapshot,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    label,
    planDebug,
  });
}
