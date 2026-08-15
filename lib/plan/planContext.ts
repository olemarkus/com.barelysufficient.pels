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

/**
 * Producer-resolved cheap/expensive classification of the current hour, for the
 * price-optimization deltas only.
 *
 * Resolved ONCE per plan build (`buildPlanContext`) instead of per device.
 * Resolving it in the consumer cost ~25 ms a time on a Homey Pro — every
 * `isCurrentHourCheap()` rebuilds the whole combined price series from settings
 * (`PriceService.getCombinedHourlyPrices`, uncached: ~12 settings reads, one
 * `Intl.DateTimeFormat.formatToParts` per spot hour, a full grid-tariff pass) —
 * and the two per-device loops asked it 52 times per rebuild between them, which
 * was ~1.28 s of the ~1.29 s plan build in production. The answer cannot change
 * within a cycle, so one resolution per build is the same answer for 1/26th of
 * the cost.
 *
 * Both flags are false when nothing in the build can spend a price delta —
 * price optimization switched off, or no admitted device configured for it. That
 * is the consumers' own combined `priceOptimizationEnabled && config?.enabled`
 * guard, hoisted (see `PlanBuilder.resolveCurrentHourPriceLevel`), so a home that
 * cannot use a level never pays to resolve one. Both halves matter: the global
 * switch defaults ON on an unset key, so gating on it alone would charge a fresh
 * install two price-series rebuilds per plan rebuild for a delta no device
 * receives.
 *
 * The consumers still check the switch themselves, and the build is async, so a
 * switch flipped ON mid-build leaves this cycle unmodulated rather than
 * half-modulated; the settings write schedules its own rebuild, which resolves
 * the level and applies the delta. Deliberate: one snapshot of the switch per
 * build beats two reads that can disagree between devices.
 *
 * The two are NOT mutually exclusive: `getPriceLevelFlags` classifies on
 * `price <= low` and `price >= high`, so at `price_threshold_percent` 0 a price
 * exactly on the average is both. Consumers keep the cheap-first precedence they
 * had when they asked per device.
 */
export type CurrentHourPriceLevel = {
  cheap: boolean;
  expensive: boolean;
};

export type PlanContext = {
  devices: PlanInputDevice[];
  desiredForMode: Record<string, number>;
  total: number | null;
  /**
   * The meter total PLANNING may use: the measured figure when it is
   * trustworthy, and `null` when it is not. Absence is the semantic — there is
   * no companion flag to remember, and no way to spend an untrustworthy number
   * by forgetting to check one.
   *
   * This is the field every consumer takes. `total` above is the raw reading and
   * `powerFreshnessState` below is the freshness fact the UI renders; neither is
   * a planning input. Before 2026-08-07 consumers received the raw total plus a
   * `powerKnown` boolean and re-derived trust themselves
   * (`resolvePlanningTotalPower`, deleted with that flag), which is the
   * consumer-side provenance branch the root AGENTS.md rule forbids:
   * "Downstream layers may then assume the typed invariant holds; they must not
   * re-validate or branch on the input's source/provenance."
   *
   * The boolean is now a local inside this function — derived, used to resolve
   * the axes, and never exported.
   */
  planningTotalKw: number | null;
  hasLivePowerSample: boolean;
  powerSampleAgeMs: number | null;
  powerFreshnessState: PowerFreshnessState;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  // Required-but-nullable on the OUTPUT: `null` is "no daily budget axis this
  // cycle", which is a real state, but "the caller did not mention it" is not
  // one a consumer should have to distinguish. The INPUT below stays optional —
  // the resolution happens once, here, at the point of production.
  budgetPaceKw: number | null;
  projectedExemptKw: number | null;
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
  // BINDING (min) axis and keeps driving shedding and the full restore pass's
  // gate — though a budget-driven shedding latch no longer blocks exempt
  // candidates (`shouldPlanBudgetExemptRestores` opens the restricted
  // capacity-axis lane); these two let admission evaluate each candidate on the axis that
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
  // See `CurrentHourPriceLevel`: resolved once per build, read per device by the
  // materialization and diagnostics loops.
  currentHourPriceLevel: CurrentHourPriceLevel;
  dailyBudget?: DailyBudgetContext;
};

/**
 * Collapses "the caller omitted it" into "there is no daily-budget axis", so
 * the two states downstream consumers would otherwise have to tell apart become
 * one. Extracted rather than inlined as `?? null` at the return: `buildPlanContext`
 * sits at its complexity ceiling, and two more coalesces pushed it over.
 */
const resolveDailyPaceAxis = (value: number | null | undefined): number | null => value ?? null;

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
  // Already resolved by the caller (see `CurrentHourPriceLevel`) — this builder
  // stays free of price dependencies.
  currentHourPriceLevel: CurrentHourPriceLevel;
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
    currentHourPriceLevel,
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
    // Resolved once, here, so no consumer re-derives it from the raw pair.
    planningTotalKw: powerKnown ? total : null,
    hasLivePowerSample: freshness.hasLivePowerSample,
    powerSampleAgeMs: freshness.powerSampleAgeMs,
    powerFreshnessState: freshness.powerFreshnessState,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    budgetPaceKw: resolveDailyPaceAxis(budgetPaceKw),
    projectedExemptKw: resolveDailyPaceAxis(projectedExemptKw),
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
    currentHourPriceLevel,
    dailyBudget,
  };
}
