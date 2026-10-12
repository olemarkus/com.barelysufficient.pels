import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import { buildPlanBreakdown } from './dailyBudgetBreakdown';
import {
  buildDailyBudgetSnapshot,
  resolvePlannedSplit,
  type BudgetState,
  type DayContext,
} from './dailyBudgetState';
import { getEffectiveProfileData } from './dailyBudgetProfile';
import { logDailyBudgetPlanDebug } from './dailyBudgetManagerPlan';
import type {
  ConfidenceDebug,
  DailyBudgetDayPayload,
  DailyBudgetSettings,
  DailyBudgetState,
} from './dailyBudgetTypes';
import type { DailyBudgetManagerDeps, PlanResult } from './dailyBudgetManagerTypes';
import type { StructuredDebugEmitter } from '../logging/logger';
import { logUncontrolledReserveDebug as logReserveDebug } from './dailyBudgetReserveLogging';

function logBudgetSummary(
  debugStructured: StructuredDebugEmitter,
  context: DayContext,
  budget: BudgetState,
): void {
  debugStructured({
    event: 'daily_budget_summary',
    usedNowKWh: context.usedNowKWh,
    allowedNowKWh: budget.allowedNowKWh,
    remainingKWh: budget.remainingKWh,
    confidence: budget.confidence,
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
  planningCeiling: PowerLimitCeiling | null;
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
    planningCeiling,
    priceOptimizationEnabled,
  } = params;
  // Only a rebuild carries bounds, and only a rebuild is logged.
  const { bounds } = plan;
  const shouldLog = bounds !== undefined && (deps.isDebugTopicEnabled?.('daily_budget') ?? true);
  if (shouldLog) logBudgetSummary(debugStructured, context, budget);
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
  const snapshot = buildDailyBudgetSnapshot({
    context,
    settings,
    enabled,
    plannedKWh: plan.plannedKWh,
    plannedGrossUncontrolledKWh: plan.plannedGrossUncontrolledKWh,
    ...resolvePlannedSplit(plan.plannedKWh, breakdown),
    priceData: plan.priceData,
    budget,
    frozen: Boolean(state.frozen),
    confidenceDebug,
    planningCeiling,
    // Stable day-start weights for the single budget-pace reference + projection.
    stableWeights: profileData.combinedWeights,
  });
  if (shouldLog) {
    logDailyBudgetPlanDebug({
      debugStructured,
      snapshot,
      priceData: plan.priceData,
      priceOptimizationEnabled,
      planningCeiling,
      settings,
      state,
      defaultProfile,
      bounds,
      uncontrolledReserveDiagnostics: plan.uncontrolledReserveDiagnostics,
    });
    if (plan.uncontrolledReserveDiagnostics) {
      logReserveDebug(plan.uncontrolledReserveDiagnostics, settings.controlledUsageWeight, deps.structuredDebug);
    }
  }
  return snapshot;
}
