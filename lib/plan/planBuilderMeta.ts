/**
 * Plan-meta assembly and power-freshness transition logging, sliced out of
 * `planBuilder.ts` to keep that entry point under the line budget. These are
 * private helpers of the builder; nothing here changes behaviour — the meta
 * object, shortfall fields, headroom log fields, and freshness transition logs
 * are byte-for-byte what the builder produced inline.
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DevicePlan, DevicePlanDevice } from './planTypes';
import type { PlanContext } from './planContext';
import type { Logger as PinoLogger } from '../logging/logger';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { splitControlledUsageKw } from './planUsage';
import {
  extractDailyBudgetHourKWh as extractPlanDailyBudgetHourKWh,
  getHourUsageSplit,
} from './planDailyBudgetWindow';

type ShortfallMeta = Pick<
  DevicePlan['meta'],
  | 'capacityShortfall'
  | 'shortfallBudgetThresholdKw'
  | 'shortfallBudgetHeadroomKw'
  | 'hardCapLimitKw'
  | 'hardCapHeadroomKw'
>;

export function buildPlanMeta(params: {
  context: PlanContext;
  planDevices: DevicePlanDevice[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  powerTracker: PowerTrackerState;
  capacityGuard: CapacityGuard | undefined;
  capacityLimitKw: number;
  hourlyBudgetExhausted: boolean;
}): DevicePlan['meta'] {
  const {
    context,
    planDevices,
    dailyBudgetSnapshot,
    powerTracker,
    capacityGuard,
    capacityLimitKw,
    hourlyBudgetExhausted,
  } = params;
  const { controlledKw, uncontrolledKw } = splitControlledUsageKw({
    devices: planDevices,
    totalKw: context.total,
  });
  const currentHourUsageSplit = getHourUsageSplit(powerTracker, context.hourBucketKey);
  const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
  const shortfallMeta = buildShortfallMeta(capacityGuard, context.total, capacityLimitKw);
  return {
    totalKw: context.total,
    softLimitKw: context.softLimit,
    capacitySoftLimitKw: context.capacitySoftLimit,
    dailySoftLimitKw: context.dailySoftLimit,
    softLimitSource: context.softLimitSource,
    headroomKw: context.headroom,
    powerKnown: context.powerKnown,
    hasLivePowerSample: context.hasLivePowerSample,
    powerSampleAgeMs: context.powerSampleAgeMs,
    powerFreshnessState: context.powerFreshnessState,
    ...shortfallMeta,
    hourlyBudgetExhausted,
    usedKWh: context.usedKWh,
    budgetKWh: context.budgetKWh,
    capacityLimitKw,
    minutesRemaining: context.minutesRemaining,
    controlledKw: controlledKw ?? undefined,
    uncontrolledKw: uncontrolledKw ?? undefined,
    hourControlledKWh: currentHourUsageSplit.controlledKWh,
    hourUncontrolledKWh: currentHourUsageSplit.uncontrolledKWh,
    dailyBudgetRemainingKWh: today?.state.remainingKWh ?? 0,
    dailyBudgetExceeded: today?.state.exceeded ?? false,
    dailyBudgetHourKWh: extractPlanDailyBudgetHourKWh(dailyBudgetSnapshot),
    lastPowerUpdateMs: typeof powerTracker.lastTimestamp === 'number'
      ? powerTracker.lastTimestamp
      : undefined,
  };
}

export function emitPowerFreshnessTransitionLogs(
  structuredLog: PinoLogger | undefined,
  previousState: PlanContext['powerFreshnessState'] | null,
  currentState: PlanContext['powerFreshnessState'],
  context: PlanContext,
): void {
  emitStaleHoldTransitionLogs(structuredLog, previousState, currentState, context);
  emitFailClosedTransitionLogs(structuredLog, previousState, currentState, context);
}

function emitStaleHoldTransitionLogs(
  structuredLog: PinoLogger | undefined,
  previousState: PlanContext['powerFreshnessState'] | null,
  currentState: PlanContext['powerFreshnessState'],
  context: PlanContext,
): void {
  if (previousState !== 'stale_hold' && currentState === 'stale_hold') {
    structuredLog?.warn?.({
      event: 'power_sample_stale_hold_entered',
      powerSampleAgeMs: context.powerSampleAgeMs,
      syntheticHeadroomKw: context.headroomRaw,
    });
  } else if (previousState === 'stale_hold' && currentState !== 'stale_hold') {
    structuredLog?.info?.({
      event: 'power_sample_stale_hold_cleared',
      powerSampleAgeMs: context.powerSampleAgeMs,
    });
  }
}

function emitFailClosedTransitionLogs(
  structuredLog: PinoLogger | undefined,
  previousState: PlanContext['powerFreshnessState'] | null,
  currentState: PlanContext['powerFreshnessState'],
  context: PlanContext,
): void {
  if (previousState !== 'stale_fail_closed' && currentState === 'stale_fail_closed') {
    structuredLog?.warn?.({
      event: 'power_sample_stale_fail_closed_entered',
      powerSampleAgeMs: context.powerSampleAgeMs,
      syntheticHeadroomKw: -1,
    });
  } else if (previousState === 'stale_fail_closed' && currentState !== 'stale_fail_closed') {
    structuredLog?.info?.({
      event: 'power_sample_stale_fail_closed_cleared',
      powerSampleAgeMs: context.powerSampleAgeMs,
    });
  }
}

function buildShortfallMeta(
  capacityGuard: CapacityGuard | undefined,
  totalKw: number | null,
  hardCapLimitKw: number,
): ShortfallMeta {
  const shortfallBudgetThresholdKw = capacityGuard?.getShortfallThreshold();
  const shortfallBudgetHeadroomKw
    = typeof totalKw === 'number' && typeof shortfallBudgetThresholdKw === 'number'
      ? shortfallBudgetThresholdKw - totalKw
      : null;
  const hardCapHeadroomKw = typeof totalKw === 'number'
    ? hardCapLimitKw - totalKw
    : null;
  return {
    capacityShortfall: capacityGuard?.isInShortfall() ?? false,
    shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw,
    hardCapLimitKw,
    hardCapHeadroomKw,
  };
}

export function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  capacityGuard: CapacityGuard | undefined,
  hardCapLimitKw: number,
): Record<string, number | boolean | string | null> {
  const shortfallBudgetThresholdKw = capacityGuard?.getShortfallThreshold();
  const shortfallBudgetHeadroomKw
    = typeof context.total === 'number' && typeof shortfallBudgetThresholdKw === 'number'
      ? shortfallBudgetThresholdKw - context.total
      : null;
  const hardCapHeadroomKw = typeof context.total === 'number'
    ? hardCapLimitKw - context.total
    : null;
  return {
    totalKw: context.total,
    softLimitKw: context.softLimit,
    softHeadroomKw: context.headroom,
    powerKnown: context.powerKnown,
    hasLivePowerSample: context.hasLivePowerSample,
    powerSampleAgeMs: context.powerSampleAgeMs,
    powerFreshnessState: context.powerFreshnessState,
    shortfallBudgetThresholdKw: shortfallBudgetThresholdKw ?? null,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw !== null ? hardCapHeadroomKw < 0 : false,
  };
}
