import type { MeasuredPower, PlanContext, PlanLimits, PlanLimitSource, LimitHeadroom } from '../../lib/plan/planContext';
import type { TemperatureIntentReads } from '../../lib/thermostat/temperatureSetpoints';
import { resolveFixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';

/**
 * A measurement a spec pins directly — for the many cases that are about a
 * particular headroom rather than a particular reading. Defaults describe an
 * on-track cycle: 3 kW drawn at time 0, 1 kW of headroom on the binding and capacity
 * axes, no daily axis, capacity not breached. `physicalLimitBreached` is
 * derived from the two breach flags exactly as `resolveMeasuredPower` derives
 * it, unless the spec pins it.
 */
export type MeasuredPowerFixtureOverrides = Partial<MeasuredPower> & {
  headroomKw?: number | null;
  capacityHeadroomKw?: number | null;
  gridHeadroomKw?: number | null;
  budgetHeadroomKw?: number | null;
};

export const headroomFixture = (kw: number | null): LimitHeadroom => kw === null
  ? { kind: 'off' } : { kind: 'on', kw };

export const buildMeasuredPower = (overrides: MeasuredPowerFixtureOverrides = {}): MeasuredPower => {
  const {
    physicalLimitBreached, headroomKw = 1, capacityHeadroomKw = 1, gridHeadroomKw = null,
    budgetHeadroomKw = null, ...rest
  } = overrides;
  const power = {
    gridHeadroom: headroomFixture(gridHeadroomKw),
    gridBreached: false,
    drawKw: 3,
    sampledAtMs: 0,
    headroom: headroomFixture(headroomKw),
    capacityHeadroom: headroomFixture(capacityHeadroomKw),
    budgetHeadroom: headroomFixture(budgetHeadroomKw),
    capacityBreached: false,
    ...rest,
  };
  return { ...power, physicalLimitBreached: physicalLimitBreached ?? (power.capacityBreached || power.gridBreached) };
};

/**
 * What a spec may add to a frame override: the reads the fixture resolves the
 * devices' setpoints from, through the real resolver, when the spec does not pin
 * `temperatureSetpoints` itself. Absent, every device is a heater kept at its
 * own setpoint with no price shift — the frame a spec not about setpoints wants.
 */
export type PlanLimitFixtureOverrides = {
  softLimit?: number | null;
  capacitySoftLimit?: number | null;
  gridImportLimitKw?: number | null;
  gridImportTargetKw?: number | null;
  dailySoftLimit?: number | null;
  budgetPaceKw?: number | null;
  projectedExemptKw?: number | null;
  softLimitSource?: PlanLimitSource | null;
};

export type PlanContextFixtureOverrides = Partial<PlanContext> & PlanLimitFixtureOverrides & {
  intent?: Partial<TemperatureIntentReads>;
};

/** Legacy scenario shorthand is resolved only at this test boundary. */
export const planLimitsFixture = (overrides: PlanLimitFixtureOverrides = {}): PlanLimits => {
  const {
    softLimit = 0, capacitySoftLimit = 0, gridImportLimitKw = null, gridImportTargetKw = null,
    dailySoftLimit = null, budgetPaceKw = null, projectedExemptKw = null, softLimitSource = 'capacity',
  } = overrides;
  const gridTargetKw = gridImportTargetKw ?? (gridImportLimitKw === null ? null : gridImportLimitKw * 0.95);
  return {
    capacity: capacitySoftLimit === null ? { kind: 'off' } : { kind: 'on', paceKw: capacitySoftLimit },
    grid: gridTargetKw === null ? { kind: 'off' }
      : { kind: 'on', limitKw: gridImportLimitKw ?? gridTargetKw / 0.95, targetKw: gridTargetKw },
    daily: dailySoftLimit === null ? { kind: 'off' }
      : { kind: 'on', budgetPaceKw: budgetPaceKw ?? dailySoftLimit, projectedExemptKw: projectedExemptKw ?? 0 },
    binding: softLimit === null || softLimitSource === null ? { kind: 'none' }
      : { kind: 'bound', source: softLimitSource, kw: softLimit },
  };
};

/**
 * The frame every planner-stage spec starts from: no devices, zero limits,
 * capacity-bound, an unremarkable hour. A spec overrides what it is about.
 */
export const buildPlanContextFixture = (spec: PlanContextFixtureOverrides = {}): PlanContext => {
  const {
    intent = {}, softLimit, capacitySoftLimit, gridImportLimitKw, gridImportTargetKw,
    dailySoftLimit, budgetPaceKw, projectedExemptKw, softLimitSource, ...overrides
  } = spec;
  return {
    ...planLimitsFixture({
      softLimit, capacitySoftLimit, gridImportLimitKw, gridImportTargetKw,
      dailySoftLimit, budgetPaceKw, projectedExemptKw, softLimitSource,
    }),
    nowTs: Date.now(),
    devices: [],
    temperatureSetpoints: resolveFixtureTemperatureSetpoints(overrides.devices ?? [], intent),
    hourBucketKey: '2024-01-01T00',
    hourUsedKWh: 0,
    capacityPeriodMinutes: 60,
    capacityPeriodCoverageComplete: true,
    budgetKWh: 0,
    usedKWh: 0,
    minutesRemaining: 60,
    ...overrides,
  };
};

/**
 * The old fixtures spelled the frame and the measurement as one object. This
 * splits such a spec: the measurement keys (and the legacy `headroom` /
 * `headroomRaw` / `total` spellings) become a `MeasuredPower`, everything else
 * the `PlanContext`. `capacityBreached` defaults to the derived answer — the
 * draw above the capacity pace — exactly as the producer resolves it.
 */
export type PlanCycleSpec = Omit<PlanContextFixtureOverrides, 'headroom'> & Omit<MeasuredPowerFixtureOverrides, 'headroom'> & {
  total?: number;
  headroom?: number;
  headroomRaw?: number;
};

export const buildPlanCycle = (spec: PlanCycleSpec = {}): { context: PlanContext; power: MeasuredPower } => {
  const {
    total, headroom, headroomRaw, drawKw, headroomKw, capacityHeadroomKw, budgetHeadroomKw,
    capacityBreached, physicalLimitBreached, gridHeadroomKw, gridBreached,
    capacityHeadroom, gridHeadroom: explicitGridHeadroom, budgetHeadroom, sampledAtMs,
    ...contextOverrides
  } = spec;
  const context = buildPlanContextFixture(contextOverrides);
  const draw = drawKw ?? total ?? 3;
  const binding = headroomKw === undefined ? headroom ?? headroomRaw ?? 0 : headroomKw;
  const gridHeadroom = context.grid.kind === 'off' ? null : context.grid.targetKw - draw;
  return {
    context,
    power: buildMeasuredPower({
      gridHeadroomKw: gridHeadroomKw === undefined ? gridHeadroom : gridHeadroomKw,
      gridBreached: gridBreached ?? (gridHeadroom !== null && gridHeadroom < 0),
      drawKw: draw,
      headroomKw: binding,
      capacityHeadroomKw: capacityHeadroomKw === undefined ? binding : capacityHeadroomKw,
      budgetHeadroomKw: budgetHeadroomKw ?? null,
      capacityBreached: capacityBreached ?? (context.capacity.kind === 'on' && draw > context.capacity.paceKw),
      ...(capacityHeadroom === undefined ? {} : { capacityHeadroom }),
      ...(explicitGridHeadroom === undefined ? {} : { gridHeadroom: explicitGridHeadroom }),
      ...(budgetHeadroom === undefined ? {} : { budgetHeadroom }),
      ...(sampledAtMs === undefined ? {} : { sampledAtMs }),
      ...(physicalLimitBreached === undefined ? {} : { physicalLimitBreached }),
    }),
  };
};


/**
 * A spec's whole cycle as ONE value — the frame and the measurement merged —
 * for the many older specs whose helper spelled both together. It satisfies
 * `PlanContext` and `MeasuredPower` alike, so a stage that takes both is
 * handed the same fixture twice; production never builds such an object.
 */
export type PlanCycle = PlanContext & MeasuredPower;

export const buildPlanCycleObject = (spec: PlanCycleSpec = {}): PlanCycle => {
  const { context, power } = buildPlanCycle(spec);
  return { ...context, ...power };
};

/** The two arguments a stage takes, from one merged cycle — for param-object call sites. */
export const cycleArgsFor = (cycle: PlanCycle): { context: PlanContext; power: MeasuredPower } => (
  { context: cycle, power: cycle }
);
