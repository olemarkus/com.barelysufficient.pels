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
import type { DevicePlan, DevicePlanDevice } from './planTypes';
import type { PlanContext } from './planContext';
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
  const { controlledKw, uncontrolledKw } = splitControlledUsageKw({
    devices: planDevices,
    totalKw: power.totalKw,
  });
  const currentHourUsageSplit = getHourUsageSplit(powerTracker, context.hourBucketKey);
  const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
  const shortfallMeta = buildShortfallMeta(
    capacityGuard,
    power.totalKw,
    capacityLimitKw,
    shortfallBudgetThresholdKw,
  );
  return {
    totalKw: power.totalKw,
    softLimitKw: context.softLimit,
    capacitySoftLimitKw: context.capacitySoftLimit,
    dailySoftLimitKw: context.dailySoftLimit,
    budgetPaceKw: context.budgetPaceKw,
    projectedExemptKw: context.projectedExemptKw,
    softLimitSource: context.softLimitSource,
    headroomKw: context.headroom,
    powerIsMeasured: context.powerIsMeasured,
    ...shortfallMeta,
    hourlyBudgetExhausted,
    usedKWh: context.usedKWh,
    budgetKWh: context.budgetKWh,
    capacityLimitKw,
    minutesRemaining: context.minutesRemaining,
    controlledKw,
    uncontrolledKw,
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
}

function buildShortfallMeta(
  capacityGuard: CapacityGuard,
  totalKw: number,
  hardCapLimitKw: number,
  shortfallBudgetThresholdKw: number,
): ShortfallMeta {
  const shortfallBudgetHeadroomKw = shortfallBudgetThresholdKw - totalKw;
  const hardCapHeadroomKw = hardCapLimitKw - totalKw;
  return {
    capacityShortfall: capacityGuard.isInShortfall() ?? false,
    shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw,
    hardCapLimitKw,
    hardCapHeadroomKw,
  };
}

export function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  power: PowerCycleDisplay,
  hardCapLimitKw: number,
  shortfallBudgetThresholdKw: number,
): Record<string, number | boolean | string | null> {
  const shortfallBudgetHeadroomKw = shortfallBudgetThresholdKw - power.totalKw;
  const hardCapHeadroomKw = hardCapLimitKw - power.totalKw;
  return {
    totalKw: power.totalKw,
    softLimitKw: context.softLimit,
    softHeadroomKw: context.headroom,
    // Log continuity: saved queries read `powerNowKw` as "the measured draw or
    // null". Derived here from the resolved pair — a LOG field, not a seam.
    powerNowKw: context.powerIsMeasured ? power.totalKw : null,
    shortfallBudgetThresholdKw: shortfallBudgetThresholdKw ?? null,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw < 0,
  };
}
