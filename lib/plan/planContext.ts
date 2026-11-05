import { minPowerLimit, resolveGridImportTargetKw } from './powerLimitMath';
import { gridImportTargetKw } from '../../packages/shared-domain/src/settings/powerLimits';
import type {
  CapacityPeriodMinutes, CapacitySettings, PowerLimitSettings,
} from '../../packages/contracts/src/capacitySettings';
import { resolveUsableCapacityKWh } from '../power/capacityModel';
import type { PowerTrackerState } from '../power/tracker';
import type { MeasuredPowerReading } from '../power/powerCycleReading';
import { getCurrentCapacityPeriodContext, getCurrentHourContext } from './planHourContext';
import { sumBudgetExemptMeasuredUsageKwFor } from '../power/usageAttribution';
import { toMeteredUsageDevices } from './planUsage';
import type { PlanInputDevice } from './planTypes';
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';

/**
 * The limits one plan cycle is decided against — resolved ONCE per build by
 * the builder (`PlanBuilder.resolvePlanLimits`) and held by both the ordinary
 * pipeline and the silent-meter pass.
 */
export type PlanLimitSource = 'capacity' | 'grid' | 'daily';

export type PlanLimitBinding =
  | { kind: 'none' }
  | { kind: 'bound'; source: PlanLimitSource; kw: number };

export type CapacityPlanLimit = { kind: 'off' } | {
  kind: 'on';
  paceKw: number;
  shortfallThresholdKw: number;
};
export type GridPlanLimit = { kind: 'off' } | { kind: 'on'; limitKw: number; targetKw: number };
export type DailyPlanLimit = { kind: 'off' } | {
  kind: 'on';
  budgetPaceKw: number;
  projectedExemptKw: number;
};

/** Each enabled axis holds its complete policy; binding names the lowest import pace. */
export type PlanLimits = {
  capacity: CapacityPlanLimit;
  grid: GridPlanLimit;
  daily: DailyPlanLimit;
  binding: PlanLimitBinding;
};

export type DailySoftLimitResolution = {
  budgetPaceKw: number;
  projectedExemptKw: number;
};

const SOFT_LIMIT_EPSILON = 1e-3;

/** The physical ceiling used by live headroom queries and the meter rebuild scheduler. */
export function resolvePhysicalPowerLimit(settings: PowerLimitSettings, capacityPaceKw: number | null): number | null {
  const gridTargetKw = resolveGridImportTargetKw(settings.gridImportLimitKw);
  return minPowerLimit(capacityPaceKw, gridTargetKw);
}

/** Resolve enabled axes once from the owners' accepted settings and pacing facts. */
export function buildPlanLimits(
  settings: PowerLimitSettings,
  capacity: CapacityPlanLimit,
  dailyPace: DailySoftLimitResolution | null,
): PlanLimits {
  const grid: GridPlanLimit = settings.gridImportLimitKw === null
    ? { kind: 'off' }
    : { kind: 'on', limitKw: settings.gridImportLimitKw, targetKw: gridImportTargetKw(settings.gridImportLimitKw) };
  const daily: DailyPlanLimit = dailyPace === null ? { kind: 'off' } : { kind: 'on', ...dailyPace };
  return { capacity, grid, daily, binding: resolveLimitBinding(capacity, grid, daily) };
}

/** Grid wins an exact tie; capacity wins a near tie with daily pacing. */
function resolveLimitBinding(
  capacity: CapacityPlanLimit, grid: GridPlanLimit, daily: DailyPlanLimit,
): PlanLimitBinding {
  const paces = [
    ...(capacity.kind === 'on' ? [capacity.paceKw] : []),
    ...(grid.kind === 'on' ? [grid.targetKw] : []),
    ...(daily.kind === 'on' ? [daily.budgetPaceKw + daily.projectedExemptKw] : []),
  ];
  if (paces.length === 0) return { kind: 'none' };
  const kw = Math.min(...paces);
  if (grid.kind === 'on' && grid.targetKw === kw) return { kind: 'bound', source: 'grid', kw };
  const source = capacity.kind === 'on' && Math.abs(capacity.paceKw - kw) <= SOFT_LIMIT_EPSILON ? 'capacity' : 'daily';
  return { kind: 'bound', source, kw };
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
  /** Build timestamp for planner-owned timing decisions and the period frame. */
  readonly nowTs: number;
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

/** Room on an enabled constraint; an off axis imposes no admission ceiling. */
export type LimitHeadroom = { kind: 'off' } | { kind: 'on'; kw: number };

/** Debit a constraint without enabling an axis that is off. Negative debits release room. */
export const spendLimitHeadroom = (headroom: LimitHeadroom, kw: number): LimitHeadroom => (
  headroom.kind === 'off' ? headroom : { kind: 'on', kw: headroom.kw - kw }
);

/** The strongest enabled constraint, keeping the unconstrained case explicit. */
export function minLimitHeadroom(...axes: readonly LimitHeadroom[]): LimitHeadroom {
  const enabled = axes.flatMap(axis => axis.kind === 'on' ? [axis.kw] : []);
  return enabled.length === 0 ? { kind: 'off' } : { kind: 'on', kw: Math.min(...enabled) };
}

/**
 * The measurement one plan cycle is decided against. Exists ONLY on a measured
 * cycle — there is no unmeasured variant, no sentinel, no flag: a stage that
 * holds one of these holds a real measurement. `drawKw` and the breach flags
 * are always answered; a headroom is `off` only when its limit is off (no
 * binding limit, Capacity limit off, no grid limit, no daily budget axis),
 * never because the reading is missing.
 *
 * Resolved once by `resolveMeasuredPower` from `lib/power`'s reading; the
 * planner never fetches a total from the capacity guard itself.
 */
export type MeasuredPower = {
  /** The whole-home draw, signed net (negative on export), kW. */
  drawKw: number;
  /** When the meter took this reading, ms. */
  sampledAtMs: number;
  /**
   * The spare room before the BINDING pace (`limits.binding`), kW — negative
   * when above it. Drives shedding and the full restore pass's gate.
   */
  headroom: LimitHeadroom;
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
  capacityHeadroom: LimitHeadroom;
  gridHeadroom: LimitHeadroom;
  /**
   * The draw is above the grid import target. Read where grid pressure has its
   * own policy: no shed grace (`PlanBuilder.decideOvershoot`), no recent-restore
   * grace and the `grid` shed source (`buildShedCandidateParams`), and delivered
   * relief retired on the next reading (`resolveSameMeasurementSheddingDecision`).
   */
  gridBreached: boolean;
  /** Off when no daily budget applies (sub-homes, budget disabled). */
  budgetHeadroom: LimitHeadroom;
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
    nowTs: nowMs,
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
  const { capacity, grid, daily, binding } = limits;
  const drawKw = reading.totalKw;
  const capacityBreached = capacity.kind === 'on' && drawKw > capacity.paceKw;
  const gridHeadroom: LimitHeadroom = grid.kind === 'off'
    ? { kind: 'off' } : { kind: 'on', kw: reading.headroomKw(grid.targetKw) };
  const gridBreached = gridHeadroom.kind === 'on' && gridHeadroom.kw < 0;
  const physicalLimitBreached = capacityBreached || gridBreached;
  return {
    drawKw,
    sampledAtMs: reading.lastPowerUpdateMs,
    headroom: binding.kind === 'none' ? { kind: 'off' } : { kind: 'on', kw: reading.headroomKw(binding.kw) },
    capacityHeadroom: capacity.kind === 'off'
      ? { kind: 'off' } : { kind: 'on', kw: reading.headroomKw(capacity.paceKw) },
    gridHeadroom,
    gridBreached,
    budgetHeadroom: daily.kind === 'on'
      ? { kind: 'on', kw: reading.headroomKw(daily.budgetPaceKw + sumBudgetExemptMeasuredUsageKwFor(
        toMeteredUsageDevices(devices),
        (device) => device.control.commandAuthority,
      )) }
      : { kind: 'off' },
    capacityBreached,
    physicalLimitBreached,
  };
}
