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
import type { StructuredDebugEmitter } from '../logging/logger';
import type { UncontrolledReservePlanDiagnostics } from './dailyBudgetPlanCaps';
import { logNextDayPlanDebug } from './dailyBudgetNextDayDebug';
import { logUncontrolledReserveDebug as logReserveDebug } from './dailyBudgetReserveLogging';

export function logBudgetSummaryIfNeeded(params: {
  debugStructured: StructuredDebugEmitter;
  shouldLog: boolean;
  context: DayContext;
  budget: BudgetState;
}): void {
  const { debugStructured, shouldLog, context, budget } = params;
  if (!shouldLog) return;
  debugStructured({
    event: 'daily_budget_summary',
    usedNowKWh: context.usedNowKWh,
    allowedNowKWh: budget.allowedNowKWh,
    remainingKWh: budget.remainingKWh,
    confidence: budget.confidence,
  });
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
  usableCapacityKw?: number;
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
    usableCapacityKw,
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
    usableCapacityKw,
  });
}

export function buildSnapshotAndLogDebug(params: {
  deps: DailyBudgetManagerDeps;
  debugStructured: StructuredDebugEmitter;
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
    debugStructured,
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
  logBudgetSummaryIfNeeded({ debugStructured, shouldLog, context, budget });
  const snapshot = buildSnapshot({
    state,
    settings,
    enabled,
    plan,
    budget,
    context,
    defaultProfile,
    confidenceDebug,
    usableCapacityKw: capacityBudgetKWh,
  });
  logPlanDebugIfNeeded({
    debugStructured,
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
    debugStructured,
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
  debugStructured: StructuredDebugEmitter;
  shouldLog: boolean;
  snapshot: DailyBudgetDayPayload;
  priceData: PriceData;
  priceOptimizationEnabled: boolean;
  capacityBudgetKWh?: number;
  settings: DailyBudgetSettings;
  state: DailyBudgetState;
  defaultProfile: number[];
  variant?: 'current' | 'next_day';
  planDebug?: {
    lockCurrentBucket: boolean;
    shouldLockCurrent: boolean;
    remainingStartIndex: number;
    hasPreviousPlan: boolean;
  };
  uncontrolledReserveDiagnostics?: UncontrolledReservePlanDiagnostics;
}): void {
  const {
    debugStructured,
    shouldLog,
    snapshot,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    variant,
    planDebug,
    uncontrolledReserveDiagnostics,
  } = params;
  if (!shouldLog) return;
  logDailyBudgetPlanDebug({
    debugStructured,
    snapshot,
    priceData,
    priceOptimizationEnabled,
    capacityBudgetKWh,
    settings,
    state,
    defaultProfile,
    variant,
    planDebug,
    uncontrolledReserveDiagnostics,
  });
}
