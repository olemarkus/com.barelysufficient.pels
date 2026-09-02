/**
 * Plan-meta assembly and the context headroom log fields, sliced out of
 * `planBuilder.ts` to keep that entry point under the line budget. Two writers
 * share one base: the ordinary pipeline composes the measured variant on top
 * of it, the silent-meter pass composes the unmeasured one.
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { PowerCycleDisplay } from '../power/powerCycleReading';
import type {
  DevicePlan,
  DevicePlanDevice,
  PlanMeasuredMetaFields,
  PlanMetaBase,
} from './planTypes';
import type { MeasuredPower, PlanContext } from './planContext';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { splitControlledUsageKw } from './planUsage';
import {
  extractDailyBudgetHourKWh as extractPlanDailyBudgetHourKWh,
  getHourUsageSplit,
} from './planDailyBudgetWindow';

/**
 * The facts every plan meta is written from, measured or not: the cycle's
 * frame, the reading's display projection, the materialized devices, and the
 * builder's per-cycle inputs. Held by both meta writers, which is what makes
 * it a concept rather than an argument bag — the measured writer adds the
 * `MeasuredPower` beside it, the unmeasured writer has nothing to add.
 */
export type PlanMetaCycleFacts = {
  context: PlanContext;
  /**
   * The reading's display facts for this cycle. They arrive ALONGSIDE the
   * context rather than on it: everything here is written outward onto the
   * snapshot and never read back as a control input.
   */
  reading: PowerCycleDisplay;
  planDevices: DevicePlanDevice[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  powerTracker: PowerTrackerState;
  capacityGuard: CapacityGuard;
  capacityLimitKw: number;
  hourlyBudgetExhausted: boolean;
  /** Producer-resolved `computeShortfallThreshold` for this build. */
  shortfallBudgetThresholdKw: number;
};

export function buildPlanMetaBase(facts: PlanMetaCycleFacts): PlanMetaBase {
  const {
    context, reading, dailyBudgetSnapshot, powerTracker, capacityGuard,
    capacityLimitKw, hourlyBudgetExhausted, shortfallBudgetThresholdKw,
  } = facts;
  const currentHourUsageSplit = getHourUsageSplit(powerTracker, context.hourBucketKey);
  const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
  return {
    totalKw: reading.totalKw,
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
    lastPowerUpdateMs: reading.lastPowerUpdateMs,
  };
}

/** The measured cycle's meta: the base plus every figure derived from the measurement. */
export function buildPlanMeta(facts: PlanMetaCycleFacts, power: MeasuredPower): DevicePlan['meta'] {
  return {
    ...buildPlanMetaBase(facts),
    ...resolveMeasuredMetaFields(
      power, facts.reading, facts.planDevices, facts.capacityLimitKw, facts.shortfallBudgetThresholdKw,
    ),
  };
}

/**
 * The silent-meter pass's meta: the base and the bare signal. No headroom, no
 * managed/background split, no cap distance — there is no measurement to
 * derive them from, and publishing a stand-in is what this variant exists to
 * make impossible (`PlanMeasuredMetaFields`).
 */
export function buildUnmeasuredPlanMeta(facts: PlanMetaCycleFacts): DevicePlan['meta'] {
  return { ...buildPlanMetaBase(facts), powerIsMeasured: false };
}

/**
 * The ONE constructor of the measured figures. The overshoot tracker's entry
 * log builds its capacity summary from the same call, so no second site can
 * drift from the published meta.
 */
export function resolveMeasuredMetaFields(
  power: MeasuredPower,
  reading: PowerCycleDisplay,
  planDevices: DevicePlanDevice[],
  capacityLimitKw: number,
  shortfallBudgetThresholdKw: number,
): PlanMeasuredMetaFields {
  return {
    powerIsMeasured: true,
    headroomKw: power.headroomKw,
    shortfallBudgetHeadroomKw: shortfallBudgetThresholdKw - reading.totalKw,
    hardCapHeadroomKw: capacityLimitKw - reading.totalKw,
    ...splitControlledUsageKw({ devices: planDevices, totalKw: reading.totalKw }),
  };
}

export function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  power: MeasuredPower,
  reading: PowerCycleDisplay,
  hardCapLimitKw: number,
  shortfallBudgetThresholdKw: number,
): Record<string, number | boolean | string | null> {
  const hardCapHeadroomKw = hardCapLimitKw - reading.totalKw;
  return {
    totalKw: reading.totalKw,
    softLimitKw: context.softLimit,
    softHeadroomKw: power.headroomKw,
    // Log continuity: saved queries read `powerNowKw` as "the measured draw".
    // A LOG field, not a seam.
    powerNowKw: reading.totalKw,
    shortfallBudgetThresholdKw: shortfallBudgetThresholdKw ?? null,
    shortfallBudgetHeadroomKw: shortfallBudgetThresholdKw - reading.totalKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw < 0,
  };
}
