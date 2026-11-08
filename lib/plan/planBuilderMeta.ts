/**
 * Plan-meta assembly and the context headroom log fields, sliced out of
 * `planBuilder.ts` to keep that entry point under the line budget. Two writers
 * share one base: the ordinary pipeline composes the measured variant on top
 * of it, the silent-meter pass composes the unmeasured one.
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { PowerCycleDisplay } from '../power/powerCycleReading';
import type { PhaseName } from '../../packages/planner-types/src/phaseFootprint';
import type {
  DevicePlan,
  DevicePlanDevice,
  PlanMeasuredMetaFields,
  PlanMetaBase,
} from './planTypes';
import type { CapacityPlanLimit, MeasuredPower, PlanContext, PlanLimits } from './planContext';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { splitControlledUsageKwFor } from '../power/usageAttribution';
import { toMeteredUsageDevices } from './planUsage';
import {
  extractDailyBudgetHourKWh as extractPlanDailyBudgetHourKWh,
  getHourUsageSplit,
} from './planDailyBudgetWindow';

/**
 * The facts every plan meta is written from, measured or not: the cycle's
 * frame, the reading's display projection, the materialized devices, and the
 * builder's per-cycle inputs. Held by both meta writers, which is what makes
 * it a concept rather than an argument bag — the measured writer adds the
 * `MeasuredPower` beside it, the unmeasured writer has nothing to add. The
 * overshoot tracker reads the same facts, so its entry log summarizes the meta
 * this build publishes.
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
  /** The worst phase still breached with nothing left to limit on it. */
  unrelievedPhase: PhaseName | null;
};

/** Nullable scalar fields belong to the published meta and logs, never the planner's policy. */
export function projectPlanLimits(limits: PlanLimits): Pick<PlanMetaBase,
  'softLimitKw' | 'softLimitSource' | 'capacitySoftLimitKw' | 'gridImportLimitKw' | 'gridImportTargetKw'
  | 'dailySoftLimitKw' | 'budgetPaceKw' | 'projectedExemptKw' | 'shortfallBudgetThresholdKw'> {
  const { capacity, grid, daily, binding } = limits;
  return {
    softLimitKw: binding.kind === 'bound' ? binding.kw : null,
    softLimitSource: binding.kind === 'bound' ? binding.source : null,
    capacitySoftLimitKw: capacity.kind === 'on' ? capacity.paceKw : null,
    shortfallBudgetThresholdKw: capacity.kind === 'on' ? capacity.shortfallThresholdKw : null,
    gridImportLimitKw: grid.kind === 'on' ? grid.limitKw : null,
    gridImportTargetKw: grid.kind === 'on' ? grid.targetKw : null,
    dailySoftLimitKw: daily.kind === 'on' ? daily.budgetPaceKw + daily.projectedExemptKw : null,
    budgetPaceKw: daily.kind === 'on' ? daily.budgetPaceKw : null,
    projectedExemptKw: daily.kind === 'on' ? daily.projectedExemptKw : null,
  };
}

export function buildPlanMetaBase(facts: PlanMetaCycleFacts): PlanMetaBase {
  const {
    context, reading, dailyBudgetSnapshot, powerTracker, capacityGuard,
    capacityLimitKw, hourlyBudgetExhausted,
  } = facts;
  const currentHourUsageSplit = getHourUsageSplit(powerTracker, context.hourBucketKey);
  const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
  return {
    totalKw: reading.totalKw,
    ...projectPlanLimits(context),
    // As it stands: a build with Capacity limit off cleared the incident before
    // anything read the guard (`PlanBuilder.buildPlanSnapshotWithTimings`).
    capacityShortfall: capacityGuard.isInShortfall(),
    hardCapLimitKw: capacityLimitKw,
    capacityPeriodMinutes: context.capacityPeriodMinutes,
    capacityPeriodCoverageComplete: context.capacityPeriodCoverageComplete,
    hourlyBudgetExhausted,
    hourUsedKWh: context.hourUsedKWh,
    usedKWh: context.usedKWh,
    budgetKWh: context.budgetKWh,
    capacityLimitKw,
    minutesRemaining: context.minutesRemaining,
    hourControlledKWh: context.capacityPeriodMinutes === 60 ? currentHourUsageSplit.controlledKWh : undefined,
    hourUncontrolledKWh: context.capacityPeriodMinutes === 60 ? currentHourUsageSplit.uncontrolledKWh : undefined,
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
      power, facts.reading, facts.planDevices, facts.capacityLimitKw, facts.context.capacity, facts.unrelievedPhase,
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
 * The reading's distance to the capacity period's two lines: the shortfall
 * threshold and the hard cap. Both exist only while Capacity limit is on, and
 * the build resolves both from its one settings read into the enabled capacity
 * axis (`PlanBuilder.resolveCapacityCycle`). The published meta and the
 * overshoot log take their figures from here, so they cannot disagree on
 * whether the cap applies.
 */
function resolveCapacityLineDistances(
  reading: PowerCycleDisplay,
  hardCapLimitKw: number,
  capacity: CapacityPlanLimit,
): Pick<PlanMeasuredMetaFields, 'shortfallBudgetHeadroomKw' | 'hardCapHeadroomKw'> {
  if (capacity.kind === 'off') return { shortfallBudgetHeadroomKw: null, hardCapHeadroomKw: null };
  return {
    shortfallBudgetHeadroomKw: capacity.shortfallThresholdKw - reading.totalKw,
    hardCapHeadroomKw: hardCapLimitKw - reading.totalKw,
  };
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
  capacity: CapacityPlanLimit,
  unrelievedPhase: PhaseName | null,
): PlanMeasuredMetaFields {
  return {
    powerIsMeasured: true,
    physicalLimitBreached: power.physicalLimitBreached,
    phase: power.phase,
    unrelievedPhase,
    headroomKw: power.headroom.kind === 'on' ? power.headroom.kw : null,
    ...resolveCapacityLineDistances(reading, capacityLimitKw, capacity),
    ...splitControlledUsageKwFor({
      devices: toMeteredUsageDevices(planDevices),
      totalKw: reading.totalKw,
    }, (device) => device.control.commandAuthority),
  };
}

export function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  power: MeasuredPower,
  reading: PowerCycleDisplay,
  hardCapLimitKw: number,
): Record<string, number | boolean | string | null> {
  const { shortfallBudgetHeadroomKw, hardCapHeadroomKw } = resolveCapacityLineDistances(
    reading, hardCapLimitKw, context.capacity,
  );
  return {
    totalKw: reading.totalKw,
    softLimitKw: projectPlanLimits(context).softLimitKw,
    softHeadroomKw: power.headroom.kind === 'on' ? power.headroom.kw : null,
    // Log continuity: saved queries read `powerNowKw` as "the measured draw".
    // A LOG field, not a seam.
    powerNowKw: reading.totalKw,
    shortfallBudgetThresholdKw: projectPlanLimits(context).shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw !== null && hardCapHeadroomKw < 0,
  };
}
