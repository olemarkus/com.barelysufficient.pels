import CapacityGuard from '../power/capacityGuard';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import type { PowerTrackerState } from '../power/tracker';
import { getCurrentHourContext } from './planHourContext';
import { resolvePowerSampleFreshness, type PowerFreshnessState } from './planPowerFreshness';
import { isCapacityBreached } from './planRemainingSheddableLoad';
import { sumBudgetExemptMeasuredUsageKw } from './planUsage';
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
  // Per-axis restore-admission inputs (notes/safe-pace-two-constraints.md
  // § "Proposed model", restore-admission-scoped). `headroom` above stays the
  // BINDING (min) axis and keeps driving shedding and the should-plan-restores
  // gate; these two let admission evaluate each candidate on the axis that
  // actually constrains it: a budget-exempt candidate admits against capacity
  // only (its own projection already sits in the daily add-back — gating it on
  // the binding pace made its reservation unusable by construction, prod
  // 2026-08-01), and a non-exempt candidate must also fit the budget pace with
  // a MEASURED exempt sum, so it cannot spend headroom that exists only as an
  // off exempt device's projection. Both carry the same stale-meter forcing as
  // `headroom` (stale_hold → 0, stale_fail_closed → -1) and the exhausted-hour
  // force, so fail-closed and exhausted hours still block every restore.
  capacityHeadroomKw: number;
  // null when no daily budget applies (sub-homes, budget disabled).
  budgetHeadroomKw: number | null;
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

  // One rule for every admission axis: fresh power reads the real difference,
  // stale_hold synthesizes 0, stale_fail_closed forces -1.
  const resolveAxisHeadroomKw = (limitKw: number): number => {
    if (powerKnown && total !== null) return limitKw - total;
    return freshness.powerFreshnessState === 'stale_fail_closed' ? -1 : 0;
  };

  const headroomRaw = resolveAxisHeadroomKw(softLimit);
  // headroom is the ACTUAL available capacity. Use this for shedding.
  let headroom = headroomRaw;

  let capacityHeadroomKw = resolveAxisHeadroomKw(capacitySoftLimit);
  // Budget axis with the MEASURED exempt sum (see the field doc): only exists
  // when the daily pace resolved this cycle.
  const hasBudgetAxis = dailySoftLimit !== null && typeof budgetPaceKw === 'number' && Number.isFinite(budgetPaceKw);
  let budgetHeadroomKw = hasBudgetAxis
    ? resolveAxisHeadroomKw(budgetPaceKw + sumBudgetExemptMeasuredUsageKw(devices))
    : null;

  // If the hourly energy budget is exhausted and soft limit is zero while instantaneous power reads ~0,
  // force a minimal negative headroom to proactively shed controllable devices.
  if (hourlyBudgetExhausted && softLimit <= 0 && total !== null && total <= 0.01) {
    headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
    // An exhausted hour blocks every restore, including budget-exempt candidates
    // on the capacity axis (the note's exhausted-hour carve-out).
    capacityHeadroomKw = -1;
    if (budgetHeadroomKw !== null) budgetHeadroomKw = -1;
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
    capacityHeadroomKw,
    budgetHeadroomKw,
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
