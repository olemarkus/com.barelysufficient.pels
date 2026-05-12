import { buildPlanBreakdown } from './dailyBudgetBreakdown';
import {
  buildDailyBudgetSnapshot,
  resolvePlannedSplit,
  type BudgetState,
  type DayContext,
  type PriceData,
} from './dailyBudgetState';
import { getEffectiveProfileData } from './dailyBudgetProfile';
import { logDailyBudgetPlanDebug } from './dailyBudgetManagerPlan';
import type { CombinedPriceData } from './dailyBudgetMath';
import type {
  ConfidenceDebug,
  DailyBudgetDayPayload,
  DailyBudgetSettings,
  DailyBudgetState,
} from './dailyBudgetTypes';
import type { DailyBudgetManagerDeps, PlanResult } from './dailyBudgetManagerTypes';
import type { UncontrolledReservePlanDiagnostics } from './dailyBudgetPlanCaps';
import { logNextDayPlanDebug } from './dailyBudgetNextDayDebug';
import { logUncontrolledReserveDebug as logReserveDebug } from './dailyBudgetReserveLogging';

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
  confidenceDebug?: ConfidenceDebug;
}): DailyBudgetDayPayload {
  const {
    state,
    settings,
    enabled,
    plan,
    budget,
    context,
    defaultProfile,
    confidenceDebug,
  } = params;
  const profileData = getEffectiveProfileData(state, settings, defaultProfile);
  const breakdown = plan.plannedUncontrolledKWh && plan.plannedControlledKWh
    ? {
      plannedUncontrolledKWh: plan.plannedUncontrolledKWh,
      plannedControlledKWh: plan.plannedControlledKWh,
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
    ...resolvePlannedSplit(plan.plannedKWh, breakdown),
    priceData: plan.priceData,
    budget,
    frozen: Boolean(state.frozen),
    confidenceDebug,
  });
}

export function buildSnapshotAndLogDebug(params: {
  deps: DailyBudgetManagerDeps;
  state: DailyBudgetState;
  settings: DailyBudgetSettings;
  enabled: boolean;
  plan: PlanResult;
  budget: BudgetState;
  context: DayContext;
  defaultProfile: number[];
  confidenceDebug?: ConfidenceDebug;
  capacityBudgetKWh?: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
}): DailyBudgetDayPayload {
  const {
    deps,
    state,
    settings,
    enabled,
    plan,
    budget,
    context,
    defaultProfile,
    confidenceDebug,
    capacityBudgetKWh,
    combinedPrices,
    priceOptimizationEnabled,
  } = params;
  const shouldLog = plan.shouldLog && (deps.isDebugTopicEnabled?.('daily_budget') ?? true);
  logBudgetSummaryIfNeeded({ logDebug: deps.logDebug, shouldLog, context, budget });
  const snapshot = buildSnapshot({ state, settings, enabled, plan, budget, context, defaultProfile, confidenceDebug });
  logPlanDebugIfNeeded({
    logDebug: deps.logDebug,
    shouldLog,
    snapshot,
    priceData: plan.priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    planDebug: plan.planDebug,
    uncontrolledReserveDiagnostics: plan.uncontrolledReserveDiagnostics,
  });
  logNextDayPlanDebug({
    logDebug: deps.logDebug,
    shouldLog,
    context,
    settings,
    state,
    combinedPrices,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    defaultProfile,
  });
  logReserveDebug({
    plan,
    reserveMode: settings.controlledUsageWeight,
    shouldLog,
    structuredDebug: deps.structuredDebug,
  });
  return snapshot;
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
  uncontrolledReserveDiagnostics?: UncontrolledReservePlanDiagnostics;
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
    uncontrolledReserveDiagnostics,
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
    uncontrolledReserveDiagnostics,
  });
}
