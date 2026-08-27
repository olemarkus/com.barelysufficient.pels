import { resolveUsableCapacityKw } from '../power/capacityModel';
import type { PowerTrackerState } from '../power/tracker';
import type { PowerCycleReading } from '../power/powerCycleReading';
import { getCurrentHourContext } from './planHourContext';
import { sumBudgetExemptMeasuredUsageKw } from './planUsage';
import type { PlanInputDevice } from './planTypes';
import type { TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';

// "The house is drawing nothing." Small enough that a real idle home clears it
// and any running load does not.
const IDLE_HOUSE_KW = 0.01;

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
  modeTargetCFor: (device: PlanInputDevice & TemperaturePlanInputKind) => number;
  /**
   * The planner's entire power vocabulary: ask for a limit, get the headroom
   * against it. Always a number.
   *
   * There is no total here, no freshness label, and nothing to discriminate.
   * `lib/power` owns the meter, so it decides what a doubtful reading means and
   * answers in kW — the planner cannot tell a measured headroom from a
   * synthesized one, and has no business trying (2026-08-16 ruling; the twin of
   * `observationStale` being off the plan kinds).
   *
   * The lineage: consumers once received a raw total plus a `powerKnown` boolean
   * and re-derived trust themselves; 2026-08-07 replaced that with a single
   * `planningTotalKw` whose absence carried the meaning; this removes the
   * absence too, because a nullable is still a consumer-side branch on whether
   * the producer's answer can be believed.
   *
   * **Not an admission input.** This is the producer's raw answer; the
   * exhausted-hour force is applied ON TOP of it, into `headroom`,
   * `capacityHeadroomKw`, and `budgetHeadroomKw`. Those three are what admission
   * and shedding read. Calling this with `softLimit` returns a DIFFERENT (and
   * more permissive) number than `headroom` in an exhausted hour, so a consumer
   * that reaches for it to re-derive an axis has silently dropped that force.
   * Its only caller outside this file is `resolveMeasuredTotalKw`.
   */
  headroomForLimitKw: (limitKw: number) => number;
  /**
   * Producer-resolved: are this cycle's numbers a reading, or the producer's
   * hold? See `PowerCycleReading.isMeasured` — it says only that, never why.
   */
  powerIsMeasured: boolean;
  /**
   * Producer-resolved: is the house MEASURED to be drawing at or below this
   * limit? False whenever there is no measurement, so a caller can only ever act
   * on a positive. See `PowerCycleReading.measuredAtOrBelowKw`.
   */
  powerMeasuredAtOrBelowKw: (limitKw: number) => boolean;
  /**
   * Producer-resolved: MEASURED above the limit. Distinct from
   * `!powerMeasuredAtOrBelowKw` — an unmeasured cycle is false for both. Three
   * sites used to hand-compose this, and a fourth (`planLogging`) disagreed.
   */
  powerMeasuredAboveKw: (limitKw: number) => boolean;
  /**
   * The measured whole-home draw, or `null` when this cycle had none.
   *
   * Resolved ONCE by the producer. Two consumers need the NUMBER rather than a
   * difference — the surplus allocator's signed net (which goes negative on
   * export) and the shortfall deficit — and for them "we did not measure" has no
   * safe numeric stand-in: a synthesized 0 would read as a balanced house to one
   * and no deficit to the other. Every other consumer wants a headroom or a
   * predicate above and must not reach for this.
   *
   * It is the one nullable left on the power axis, and it is genuine domain
   * absence rather than an unresolved read. It replaced a derivation that
   * recovered the draw by negating `headroomForLimitKw(0)` — correct only while
   * that answer stayed exactly linear and unclamped, an invariant held by comment.
   */
  measuredDrawKw: number | null;
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
  /**
   * This cycle's reading, resolved by `lib/power`. The planner does not fetch a
   * total from the capacity guard any more — it is handed the answers.
   */
  power: PowerCycleReading;
  capacitySettings: { limitKw: number; marginKw: number };
  /** Hourly usage/bucket math only. Not a freshness input — that is `power`'s. */
  powerTracker: PowerTrackerState;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  budgetPaceKw?: number | null;
  projectedExemptKw?: number | null;
  softLimitSource: SoftLimitSource;
  /**
   * The setpoint this home's active mode holds a temperature device at.
   *
   * A TOTAL function of the device, not a map: "does this mode have a target for
   * this device" is not a question any planner stage can ask, because there is
   * no absent case to observe. The producer resolves it once — the stored
   * per-mode entry, else the device's own setpoint, which commands nothing new.
   *
   * It was `Record<string, number>`, which typed every lookup as a `number` the
   * map could not guarantee; the seed then carried a `Number.isFinite` fallback
   * for a case the type called impossible.
   */
  modeTargetCFor: (device: PlanInputDevice & TemperaturePlanInputKind) => number;
  hourlyBudgetExhausted: boolean;
  // Already resolved by the caller (see `CurrentHourPriceLevel`) — this builder
  // stays free of price dependencies.
  currentHourPriceLevel: CurrentHourPriceLevel;
  dailyBudget?: DailyBudgetContext;
}): PlanContext {
  const {
    devices,
    power,
    capacitySettings,
    powerTracker,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    budgetPaceKw,
    projectedExemptKw,
    softLimitSource,
    modeTargetCFor,
    hourlyBudgetExhausted,
    currentHourPriceLevel,
    dailyBudget,
  } = params;

  const now = Date.now();

  // Compute used/budget kWh for this hour
  const budgetKWh = resolveUsableCapacityKw(capacitySettings);
  const hourContext = getCurrentHourContext(powerTracker, now);
  const usedKWh = hourContext.usedKWh;
  const minutesRemaining = hourContext.minutesRemaining;

  // Every admission axis asks the producer the same way. What a doubtful meter
  // means to the answer is `lib/power`'s business, not this builder's.
  const resolveAxisHeadroomKw = power.headroomKw;

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
  // The ~0 read must be MEASURED: this used to test the raw cached total, which
  // could fire off a reading the meter had long stopped confirming.
  if (hourlyBudgetExhausted && softLimit <= 0 && power.measuredAtOrBelowKw(IDLE_HOUSE_KW)) {
    headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
    // An exhausted hour blocks every restore, including budget-exempt candidates
    // on the capacity axis (the note's exhausted-hour carve-out).
    capacityHeadroomKw = -1;
    if (budgetHeadroomKw !== null) budgetHeadroomKw = -1;
  }

  return {
    devices,
    modeTargetCFor,
    headroomForLimitKw: power.headroomKw,
    powerIsMeasured: power.isMeasured,
    powerMeasuredAtOrBelowKw: power.measuredAtOrBelowKw,
    powerMeasuredAboveKw: power.measuredAboveKw,
    measuredDrawKw: power.display.measuredTotalKw,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    budgetPaceKw: resolveDailyPaceAxis(budgetPaceKw),
    projectedExemptKw: resolveDailyPaceAxis(projectedExemptKw),
    softLimitSource,
    // "Capacity is not the constraint doing the work" — which requires having
    // MEASURED that, not merely having synthesized a headroom. The old form was
    // `powerKnown && !isCapacityBreached(total, capacitySoftLimit)`; both halves
    // fold into the one producer question.
    budgetReleasableHeadroomHold: softLimitSource === 'daily'
      && power.measuredAtOrBelowKw(capacitySoftLimit),
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
