import { resolveUsableCapacityKw } from '../power/capacityModel';
import type { PowerTrackerState } from '../power/tracker';
import type { MeasuredPowerReading } from '../power/powerCycleReading';
import { getCurrentHourContext } from './planHourContext';
import { sumBudgetExemptMeasuredUsageKw } from '../power/usageAttribution';
import { toUsageDevice } from './planUsage';
import { isCapacityBreached } from './planRemainingSheddableLoad';
import type { PlanInputDevice } from './planTypes';
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';

export type SoftLimitSource = 'capacity' | 'daily';

/**
 * The limits one plan cycle is decided against — resolved ONCE per build by
 * the builder (`PlanBuilder.resolvePlanLimits`) and held by both the ordinary
 * pipeline and the silent-meter pass.
 */
export type PlanLimits = {
  /** The binding pace: `min(capacitySoftLimit, dailySoftLimit)`. */
  softLimit: number;
  capacitySoftLimit: number;
  /** `null` = no daily budget axis this cycle (a real state, always written). */
  dailySoftLimit: number | null;
  budgetPaceKw: number | null;
  projectedExemptKw: number | null;
  // No `'both'`. `resolveSoftLimitSource` (`planBuilder.ts`) is total over these
  // two — when the paces coincide within `SOFT_LIMIT_EPSILON` it answers
  // `'capacity'`, not a third "they meet here" state.
  softLimitSource: SoftLimitSource;
};

/**
 * The frame one plan cycle is decided in: the admitted devices, the limits,
 * the hour's bookkeeping, and the setpoints each temperature device's outcomes
 * command.
 *
 * It carries NO measurement. Every measurement-derived quantity — the draw,
 * the headroom against each axis, whether capacity is breached — lives on
 * `MeasuredPower`, which exists only on a measured cycle. The ordinary
 * pipeline is entered only with one, so no stage inside it asks whether power
 * was measured; the one unmeasured build (the silent-meter fail-closed pass)
 * is its own short path that never constructs a `MeasuredPower` at all
 * (owner ruling 2026-09-02: guard at the seams, never per read).
 */
export type PlanContext = PlanLimits & {
  devices: PlanInputDevice[];
  /**
   * What each temperature device's outcomes command, resolved once per build
   * before the planner (`lib/thermostat`). The planner picks an outcome and
   * reads its setpoint here; it never computes one or orders two
   * (`temperatureSetpointsFor`).
   */
  temperatureSetpoints: TemperatureSetpointsByDevice;
  hourBucketKey: string;
  budgetKWh: number;
  usedKWh: number;
  minutesRemaining: number;
};

/**
 * The measurement one plan cycle is decided against. Exists ONLY on a measured
 * cycle — there is no unmeasured variant, no sentinel, no flag: a stage that
 * holds one of these holds real numbers.
 *
 * Resolved once by `resolveMeasuredPower` from `lib/power`'s reading; the
 * planner never fetches a total from the capacity guard itself.
 */
export type MeasuredPower = {
  /** The whole-home draw, signed net (negative on export), kW. */
  drawKw: number;
  /**
   * The spare room before the BINDING pace (`limits.softLimit`), kW — negative
   * when above it. Drives shedding and the full restore pass's gate.
   */
  headroomKw: number;
  // Per-axis restore-admission inputs (notes/safe-pace-two-constraints.md
  // § "Proposed model", restore-admission-scoped). A budget-driven shedding
  // latch no longer blocks exempt candidates (`shouldPlanBudgetExemptRestores`
  // opens the restricted capacity-axis lane); these two let admission evaluate
  // each candidate on the axis that actually constrains it: a budget-exempt
  // candidate admits against capacity only (its own projection already sits in
  // the daily add-back — gating it on the binding pace made its reservation
  // unusable by construction, prod 2026-08-01), and a non-exempt candidate must
  // also fit the budget pace with a MEASURED exempt sum, so it cannot spend
  // headroom that exists only as an off exempt device's projection.
  capacityHeadroomKw: number;
  /** `null` when no daily budget applies (sub-homes, budget disabled). */
  budgetHeadroomKw: number | null;
  /** The draw is above the capacity pace. The one "is capacity breached" answer every stage reads. */
  capacityBreached: boolean;
  // A headroom-blocked restore hold is releasable by the daily budget ONLY when
  // the daily pace is the binding limit and capacity is not ALSO breached: when
  // the total is over the capacity limit too, capacity is the constraint doing
  // the work and a budget release cannot help (prod 2026-07-25). Resolved to one
  // flat boolean HERE so no consumer recomposes it from ingredients —
  // `planDiagnostics` (starvation counting cause, rescue gating) and
  // `normalizeShedReasons` (device reason re-attribution) must read this same
  // field or the card and the rescue widget disagree about the hold.
  budgetReleasableHeadroomHold: boolean;
};

export function buildPlanContext(params: {
  devices: PlanInputDevice[];
  capacitySettings: { limitKw: number; marginKw: number };
  /** Hourly usage/bucket math only. Not a freshness input — that is the reading's. */
  powerTracker: PowerTrackerState;
  limits: PlanLimits;
  temperatureSetpoints: TemperatureSetpointsByDevice;
}): PlanContext {
  const {
    devices, capacitySettings, powerTracker, limits, temperatureSetpoints,
  } = params;
  const hourContext = getCurrentHourContext(powerTracker, Date.now());
  return {
    ...limits,
    devices,
    temperatureSetpoints,
    hourBucketKey: hourContext.bucketKey,
    budgetKWh: resolveUsableCapacityKw(capacitySettings),
    usedKWh: hourContext.usedKWh,
    minutesRemaining: hourContext.minutesRemaining,
  };
}

/**
 * The cycle's measurement, resolved once from `lib/power`'s reading against the
 * frame's limits. Every admission axis asks the reading the same way.
 *
 * There is no exhausted-hour override here any more: an exhausted hour is a
 * FLAG (`PlanEngineState.hourlyBudgetExhausted`), and the stages that must act
 * on it — shedding everything, admitting no restore — read the flag. Forcing
 * `-1` into these numbers to make those stages react was a decision smuggled
 * inside a measurement, and it surfaced as `1.0 kW above safe pace (0.0 kW)`
 * on the Overview beside a 0.1 kW draw.
 */
export function resolveMeasuredPower(
  reading: MeasuredPowerReading,
  limits: PlanLimits,
  devices: PlanInputDevice[],
): MeasuredPower {
  const { softLimit, capacitySoftLimit, dailySoftLimit, budgetPaceKw, softLimitSource } = limits;
  const drawKw = reading.totalKw;
  // Budget axis with the MEASURED exempt sum (see the field doc): only exists
  // when the daily pace resolved this cycle.
  const hasBudgetAxis = dailySoftLimit !== null && typeof budgetPaceKw === 'number' && Number.isFinite(budgetPaceKw);
  const capacityBreached = isCapacityBreached(drawKw, capacitySoftLimit);
  return {
    drawKw,
    headroomKw: reading.headroomKw(softLimit),
    capacityHeadroomKw: reading.headroomKw(capacitySoftLimit),
    budgetHeadroomKw: hasBudgetAxis
      ? reading.headroomKw(budgetPaceKw + sumBudgetExemptMeasuredUsageKw(devices.map(toUsageDevice)))
      : null,
    capacityBreached,
    budgetReleasableHeadroomHold: softLimitSource === 'daily' && !capacityBreached,
  };
}
