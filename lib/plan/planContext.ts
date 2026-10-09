import { gridImportTargetKw } from '../../packages/shared-domain/src/settings/powerLimits';
import { minPowerLimit } from './powerLimitMath';
import type {
  CapacityPeriodMinutes, CapacitySettings, PowerLimitSettings,
} from '../../packages/contracts/src/capacitySettings';
import { resolveUsableCapacityKWh } from '../power/capacityModel';
import type { PowerTrackerState } from '../power/tracker';
import type { MeasuredPowerReading } from '../power/powerCycleReading';
import { getCurrentCapacityPeriodContext, getCurrentHourContext } from './planHourContext';
import { sumBudgetExemptMeasuredUsageKwFor } from '../power/usageAttribution';
import { toMeteredUsageDevices } from './planUsage';
import { isCapacityBreached } from './planRemainingSheddableLoad';
import type { PlanInputDevice } from './planTypes';
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';

export type SoftLimitSource = 'capacity' | 'daily' | 'grid' | null;

/**
 * The limits one plan cycle is decided against — resolved ONCE per build by
 * the builder (`PlanBuilder.resolvePlanLimits`) and held by both the ordinary
 * pipeline and the silent-meter pass.
 */
export type PlanLimits = {
  /** The binding pace: minimum enabled capacity, budget and grid threshold. */
  softLimit: number | null;
  capacitySoftLimit: number | null;
  gridImportLimitKw: number | null;
  gridImportTargetKw: number | null;
  /** `null` = no daily budget axis this cycle (a real state, always written). */
  dailySoftLimit: number | null;
  budgetPaceKw: number | null;
  projectedExemptKw: number | null;
  // One binding source. Grid wins an exact tie; capacity wins a near tie with
  // daily pacing, preserving the existing period-control attribution.
  softLimitSource: SoftLimitSource;
};

export type DailySoftLimitResolution = {
  dailySoftLimitKw: number;
  budgetPaceKw: number;
  projectedExemptKw: number;
};

const SOFT_LIMIT_EPSILON = 1e-3;

/** The physical ceiling used by live headroom queries and the meter rebuild scheduler. */
export function resolvePhysicalPowerLimit(settings: PowerLimitSettings, capacityPaceKw: number | null): number | null {
  const gridTargetKw = settings.gridImportLimitKw === null ? null : gridImportTargetKw(settings.gridImportLimitKw);
  return minPowerLimit(capacityPaceKw, gridTargetKw);
}

/** Resolve the enabled axes once; the builder owns period state and supplies its accepted pacing facts. */
export function buildPlanLimits(
  settings: PowerLimitSettings,
  capacitySoftLimit: number | null,
  daily: DailySoftLimitResolution | null,
): PlanLimits {
  const gridTargetKw = settings.gridImportLimitKw === null ? null : gridImportTargetKw(settings.gridImportLimitKw);
  const dailySoftLimit = daily?.dailySoftLimitKw ?? null;
  return {
    softLimit: minPowerLimit(capacitySoftLimit, dailySoftLimit, gridTargetKw),
    capacitySoftLimit,
    gridImportLimitKw: settings.gridImportLimitKw,
    gridImportTargetKw: gridTargetKw,
    dailySoftLimit,
    budgetPaceKw: daily?.budgetPaceKw ?? null,
    projectedExemptKw: daily?.projectedExemptKw ?? null,
    softLimitSource: resolveSoftLimitSource(capacitySoftLimit, dailySoftLimit, gridTargetKw),
  };
}

function resolveSoftLimitSource(capacity: number | null, daily: number | null, grid: number | null): SoftLimitSource {
  const binding = minPowerLimit(capacity, daily, grid);
  if (binding === null) return null;
  if (grid === binding) return 'grid';
  return capacity !== null && Math.abs(capacity - binding) <= SOFT_LIMIT_EPSILON ? 'capacity' : 'daily';
}

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
  hourUsedKWh: number;
  capacityPeriodMinutes: CapacityPeriodMinutes;
  /** Whether usedKWh covers the whole elapsed part of this capacity period. */
  capacityPeriodCoverageComplete: boolean;
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
  headroomKw: number | null;
  // Per-axis restore-admission inputs (notes/safe-pace-two-constraints.md
  // § "Proposed model", restore-admission-scoped). A budget-driven shedding
  // latch no longer blocks exempt candidates (`shouldPlanBudgetExemptRestores`
  // opens the restricted physical-axis lane); these axes let admission evaluate
  // each candidate on the axis that actually constrains it: a budget-exempt
  // candidate admits against capacity and grid (its own projection already sits in
  // the daily add-back — gating it on the binding pace made its reservation
  // unusable by construction, prod 2026-08-01), and a non-exempt candidate must
  // also fit the budget pace with a MEASURED exempt sum, so it cannot spend
  // headroom that exists only as an off exempt device's projection.
  capacityHeadroomKw: number | null;
  gridHeadroomKw: number | null;
  /**
   * The draw is above the grid import target. Read where grid pressure has its
   * own policy: no shed grace (`PlanBuilder.decideOvershoot`), no recent-restore
   * grace and the `grid` shed source (`buildShedCandidateParams`), and delivered
   * relief retired on the next reading (`resolveSameMeasurementSheddingDecision`).
   */
  gridBreached: boolean;
  /** `null` when no daily budget applies (sub-homes, budget disabled). */
  budgetHeadroomKw: number | null;
  /**
   * The draw is above the capacity pace — capacity ONLY, `false` with Capacity
   * limit off. Read where only the capacity period is meant: the hard-cap
   * shortfall verdict (`reportShortfallToGuard`). A stage asking "is the house
   * over a limit a budget release cannot help with" reads
   * `physicalLimitBreached` instead.
   */
  capacityBreached: boolean;
  /**
   * The draw is above an enabled PHYSICAL limit: the capacity pace or the grid
   * import target, whichever are on. The one "is a physical limit breached"
   * answer every stage reads — the daily-budget exemption policy and shed
   * attribution (`buildShedCandidateParams`, `resolveShedReason`), the
   * same-sample escalation (`resolveSameMeasurementSheddingDecision`) and
   * reason normalization (`normalizeShedReasons`) — so none of them recomposes
   * it from the two axes.
   */
  physicalLimitBreached: boolean;
  // A headroom-blocked restore hold is releasable by the daily budget ONLY when
  // the daily pace binds and neither capacity nor grid is also breached: when
  // the total is over a physical limit too, that limit is the constraint doing
  // the work and a budget release cannot help (prod 2026-07-25). Resolved to one
  // flat boolean HERE so no consumer recomposes it from ingredients —
  // `planDiagnostics` (starvation counting cause, rescue gating) and
  // `normalizeShedReasons` (device reason re-attribution) must read this same
  // field or the card and the rescue widget disagree about the hold.
  budgetReleasableHeadroomHold: boolean;
};

/**
 * `powerTracker` feeds the usage/bucket math only. It is not a freshness
 * input — that is the reading's.
 */
export function buildPlanContext(
  devices: PlanInputDevice[],
  capacitySettings: CapacitySettings,
  powerTracker: PowerTrackerState,
  limits: PlanLimits,
  temperatureSetpoints: TemperatureSetpointsByDevice,
  nowMs: number,
): PlanContext {
  const hourContext = getCurrentHourContext(powerTracker, nowMs);
  const capacityContext = getCurrentCapacityPeriodContext(
    powerTracker,
    capacitySettings.periodMinutes,
    nowMs,
  );
  return {
    ...limits,
    devices,
    temperatureSetpoints,
    hourBucketKey: hourContext.bucketKey,
    hourUsedKWh: hourContext.usedKWh,
    capacityPeriodMinutes: capacitySettings.periodMinutes,
    capacityPeriodCoverageComplete: capacityContext.coverageComplete,
    budgetKWh: resolveUsableCapacityKWh(capacitySettings),
    usedKWh: capacityContext.usedKWh,
    minutesRemaining: capacityContext.minutesRemaining,
  };
}

/**
 * The cycle's measurement, resolved once from `lib/power`'s reading against the
 * frame's limits. Every admission axis asks the reading the same way.
 *
 * There is no exhausted-hour override here any more: an exhausted hour is a
 * FLAG (`PlanEngineState.hourlyBudgetExhausted`), and the stages that must act
 * on it — shedding everything, admitting no restore — read it, through
 * `PlanEngineState.capacityPeriodSpentFor` so it acts only while Capacity limit
 * is on. Forcing
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
  const gridHeadroomKw = limits.gridImportTargetKw === null ? null : reading.headroomKw(limits.gridImportTargetKw);
  const gridBreached = gridHeadroomKw !== null && gridHeadroomKw < 0;
  const physicalLimitBreached = capacityBreached || gridBreached;
  return {
    drawKw,
    headroomKw: softLimit === null ? null : reading.headroomKw(softLimit),
    capacityHeadroomKw: capacitySoftLimit === null ? null : reading.headroomKw(capacitySoftLimit),
    gridHeadroomKw,
    gridBreached,
    budgetHeadroomKw: hasBudgetAxis
      ? reading.headroomKw(budgetPaceKw + sumBudgetExemptMeasuredUsageKwFor(
        toMeteredUsageDevices(devices),
        (device) => device.control.commandAuthority,
      ))
      : null,
    capacityBreached,
    physicalLimitBreached,
    budgetReleasableHeadroomHold: softLimitSource === 'daily' && !physicalLimitBreached,
  };
}
