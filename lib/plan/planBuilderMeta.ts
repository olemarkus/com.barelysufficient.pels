/**
 * Plan-meta assembly and power-freshness transition logging, sliced out of
 * `planBuilder.ts` to keep that entry point under the line budget. These are
 * private helpers of the builder; nothing here changes behaviour — the meta
 * object, shortfall fields, headroom log fields, and freshness transition logs
 * are byte-for-byte what the builder produced inline.
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { PowerCycleDisplay } from '../power/powerCycleReading';
import type {
  DevicePlan,
  DevicePlanDevice,
  PlanMeasuredMetaFields,
  PlanMetaBase,
  PlanUnmeasuredMetaFields,
} from './planTypes';
import type { PlanContext } from './planContext';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { splitControlledUsageKw } from './planUsage';
import {
  extractDailyBudgetHourKWh as extractPlanDailyBudgetHourKWh,
  getHourUsageSplit,
} from './planDailyBudgetWindow';

export function buildPlanMeta(params: {
  context: PlanContext;
  planDevices: DevicePlanDevice[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  /**
   * The producer's display facts for this cycle. They arrive ALONGSIDE the
   * context rather than on it, so a planner stage cannot reach a freshness
   * label: everything here is written outward onto the snapshot and never read
   * back as a control input.
   */
  power: PowerCycleDisplay;
  powerTracker: PowerTrackerState;
  capacityGuard: CapacityGuard;
  capacityLimitKw: number;
  hourlyBudgetExhausted: boolean;
  /** Producer-resolved `computeShortfallThreshold` for this build. */
  shortfallBudgetThresholdKw: number;
}): DevicePlan['meta'] {
  const {
    context,
    planDevices,
    dailyBudgetSnapshot,
    power,
    powerTracker,
    capacityGuard,
    capacityLimitKw,
    hourlyBudgetExhausted,
    shortfallBudgetThresholdKw,
  } = params;
  const currentHourUsageSplit = getHourUsageSplit(powerTracker, context.hourBucketKey);
  const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
  const base: PlanMetaBase = {
    totalKw: power.totalKw,
    softLimitKw: context.softLimit,
    capacitySoftLimitKw: context.capacitySoftLimit,
    dailySoftLimitKw: context.dailySoftLimit,
    budgetPaceKw: context.budgetPaceKw,
    projectedExemptKw: context.projectedExemptKw,
    softLimitSource: context.softLimitSource,
    capacityShortfall: capacityGuard.isInShortfall() ?? false,
    shortfallBudgetThresholdKw,
    hardCapLimitKw: capacityLimitKw,
    hourlyBudgetExhausted,
    usedKWh: context.usedKWh,
    budgetKWh: context.budgetKWh,
    capacityLimitKw,
    minutesRemaining: context.minutesRemaining,
    hourControlledKWh: currentHourUsageSplit.controlledKWh,
    hourUncontrolledKWh: currentHourUsageSplit.uncontrolledKWh,
    dailyBudgetRemainingKWh: today?.state.remainingKWh ?? 0,
    dailyBudgetExceeded: today?.state.exceeded ?? false,
    dailyBudgetHourKWh: extractPlanDailyBudgetHourKWh(dailyBudgetSnapshot),
    // From the producer's reading, not a second read of the tracker: the meta
    // writer resolving its own timestamp is how two views of the same sample
    // drift apart.
    lastPowerUpdateMs: power.lastPowerUpdateMs,
  };
  return {
    ...base,
    ...resolveMeasuredMetaFields(context, power, planDevices, capacityLimitKw, shortfallBudgetThresholdKw),
  };
}

/**
 * The ONE constructor of the meta's measured/unmeasured split — the single
 * branch on the signal inside the planner. The measured figures are computed
 * and published together; the unmeasured build publishes none of them
 * (`PlanMeasuredMetaFields`). The overshoot tracker's entry log builds its
 * capacity summary from the same call, so no second site can drift from it.
 */
export function resolveMeasuredMetaFields(
  context: PlanContext,
  power: PowerCycleDisplay,
  planDevices: DevicePlanDevice[],
  capacityLimitKw: number,
  shortfallBudgetThresholdKw: number,
): PlanMeasuredMetaFields | PlanUnmeasuredMetaFields {
  if (!context.powerIsMeasured) return { powerIsMeasured: false };
  return {
    powerIsMeasured: true,
    headroomKw: context.headroom,
    shortfallBudgetHeadroomKw: shortfallBudgetThresholdKw - power.totalKw,
    hardCapHeadroomKw: capacityLimitKw - power.totalKw,
    ...splitControlledUsageKw({ devices: planDevices, totalKw: power.totalKw }),
  };
}

export function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  power: PowerCycleDisplay,
  hardCapLimitKw: number,
  shortfallBudgetThresholdKw: number,
): Record<string, number | boolean | string | null> {
  // The distances are measured figures: null on the unmeasured build, like the
  // meta publishes none and `planRebuildMetrics` logs null for the same names.
  const measured = context.powerIsMeasured
    ? {
      softHeadroomKw: context.headroom,
      powerNowKw: power.totalKw,
      shortfallBudgetHeadroomKw: shortfallBudgetThresholdKw - power.totalKw,
      hardCapHeadroomKw: hardCapLimitKw - power.totalKw,
      hardCapBreached: hardCapLimitKw - power.totalKw < 0,
    }
    : {
      softHeadroomKw: null,
      // Log continuity: saved queries read `powerNowKw` as "the measured draw
      // or null". A LOG field, not a seam.
      powerNowKw: null,
      shortfallBudgetHeadroomKw: null,
      hardCapHeadroomKw: null,
      hardCapBreached: null,
    };
  return {
    totalKw: power.totalKw,
    softLimitKw: context.softLimit,
    shortfallBudgetThresholdKw: shortfallBudgetThresholdKw ?? null,
    ...measured,
  };
}
