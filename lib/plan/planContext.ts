import CapacityGuard from '../power/capacityGuard';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import type { PowerTrackerState } from '../power/tracker';
import { getCurrentHourContext } from './planHourContext';
import { resolvePowerSampleFreshness, type PowerFreshnessState } from './planPowerFreshness';
import { isCapacityBreached } from './planRemainingSheddableLoad';
import type { PlanInputDevice } from './planTypes';

export type DailyBudgetContext = {
  enabled: boolean;
  usedNowKWh: number;
  allowedNowKWh: number;
  remainingKWh: number;
  exceeded: boolean;
  frozen: boolean;
};

export type SoftLimitSource = 'capacity' | 'daily';

export type PlanContext = {
  devices: PlanInputDevice[];
  desiredForMode: Record<string, number>;
  total: number | null;
  powerKnown: boolean;
  hasLivePowerSample: boolean;
  powerSampleAgeMs: number | null;
  powerFreshnessState: PowerFreshnessState;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  budgetPaceKw?: number | null;
  projectedExemptKw?: number | null;
  softLimitSource: SoftLimitSource;
  // A headroom-blocked restore hold is releasable by the daily budget ONLY when the
  // daily pace is the binding limit, the power sample is fresh, and capacity is not
  // ALSO breached. Fresh power: `stale_hold` synthesizes headroom 0 and
  // `stale_fail_closed` forces -1, so a stale meter blocks restores for reasons the
  // budget cannot lift. No breach: when total is over the capacity limit too,
  // capacity is the constraint doing the work and a budget release cannot help
  // (prod 2026-07-25). Resolved to one flat boolean HERE so no consumer recomposes
  // it from ingredients — `planDiagnostics` (starvation counting cause, rescue
  // gating) and `normalizeShedReasons` (device reason re-attribution) must read
  // this same field or the card and the rescue widget disagree about the hold.
  budgetReleasableHeadroomHold: boolean;
  hourBucketKey: string;
  budgetKWh: number;
  usedKWh: number;
  minutesRemaining: number;
  headroomRaw: number;
  headroom: number;
  restoreMarginPlanning: number;
  dailyBudget?: DailyBudgetContext;
};

export function buildPlanContext(params: {
  devices: PlanInputDevice[];
  capacityGuard: CapacityGuard | undefined;
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  budgetPaceKw?: number | null;
  projectedExemptKw?: number | null;
  softLimitSource: SoftLimitSource;
  desiredForMode: Record<string, number>;
  hourlyBudgetExhausted: boolean;
  dailyBudget?: DailyBudgetContext;
}): PlanContext {
  const {
    devices,
    capacityGuard,
    capacitySettings,
    powerTracker,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    budgetPaceKw,
    projectedExemptKw,
    softLimitSource,
    desiredForMode,
    hourlyBudgetExhausted,
    dailyBudget,
  } = params;

  const now = Date.now();
  const total = capacityGuard ? capacityGuard.getLastTotalPower() : null;
  const freshness = resolvePowerSampleFreshness(powerTracker, now);
  const powerKnown = freshness.powerFreshnessState === 'fresh' && total !== null;

  // Compute used/budget kWh for this hour
  const budgetKWh = resolveUsableCapacityKw(capacitySettings);
  const hourContext = getCurrentHourContext(powerTracker, now);
  const usedKWh = hourContext.usedKWh;
  const minutesRemaining = hourContext.minutesRemaining;

  let headroomRaw = 0;
  if (powerKnown && total !== null) {
    headroomRaw = softLimit - total;
  } else if (freshness.powerFreshnessState === 'stale_fail_closed') {
    headroomRaw = -1;
  }
  // headroom is the ACTUAL available capacity. Use this for shedding.
  let headroom = headroomRaw;

  // If the hourly energy budget is exhausted and soft limit is zero while instantaneous power reads ~0,
  // force a minimal negative headroom to proactively shed controllable devices.
  if (hourlyBudgetExhausted && softLimit <= 0 && total !== null && total <= 0.01) {
    headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
  }

  return {
    devices,
    desiredForMode,
    total,
    powerKnown,
    hasLivePowerSample: freshness.hasLivePowerSample,
    powerSampleAgeMs: freshness.powerSampleAgeMs,
    powerFreshnessState: freshness.powerFreshnessState,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    budgetPaceKw,
    projectedExemptKw,
    softLimitSource,
    budgetReleasableHeadroomHold: softLimitSource === 'daily'
      && powerKnown
      && !isCapacityBreached(total, capacitySoftLimit),
    hourBucketKey: hourContext.bucketKey,
    budgetKWh,
    usedKWh,
    minutesRemaining,
    headroomRaw,
    headroom,
    restoreMarginPlanning: Math.max(0.1, capacitySettings.marginKw || 0),
    dailyBudget,
  };
}
