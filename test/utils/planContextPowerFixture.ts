import type { MeasuredPower, PlanContext } from '../../lib/plan/planContext';
import { PriceLevel } from '../../lib/price/priceLevels';

/**
 * A measurement a spec pins directly — for the many cases that are about a
 * particular headroom rather than a particular reading. Defaults describe an
 * on-track cycle: 3 kW drawn, 1 kW of headroom on the binding and capacity
 * axes, no daily axis, capacity not breached.
 */
export const buildMeasuredPower = (overrides: Partial<MeasuredPower> = {}): MeasuredPower => ({
  drawKw: 3,
  headroomKw: 1,
  capacityHeadroomKw: 1,
  budgetHeadroomKw: null,
  capacityBreached: false,
  budgetReleasableHeadroomHold: false,
  ...overrides,
});

/**
 * The frame every planner-stage spec starts from: no devices, zero limits,
 * capacity-bound, an unremarkable hour. A spec overrides what it is about.
 */
export const buildPlanContextFixture = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices: [],
  modeTargetCFor: (d) => d.currentTarget,
  softLimit: 0,
  capacitySoftLimit: 0,
  dailySoftLimit: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  hourBucketKey: '2024-01-01T00',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: PriceLevel.UNKNOWN,
  ...overrides,
});

/**
 * The old fixtures spelled the frame and the measurement as one object. This
 * splits such a spec: the measurement keys (and the legacy `headroom` /
 * `headroomRaw` / `total` spellings) become a `MeasuredPower`, everything else
 * the `PlanContext`. `capacityBreached` defaults to the derived answer — the
 * draw above the capacity pace — exactly as the producer resolves it.
 */
export type PlanCycleSpec = Partial<PlanContext> & Partial<MeasuredPower> & {
  total?: number;
  headroom?: number;
  headroomRaw?: number;
};

export const buildPlanCycle = (spec: PlanCycleSpec = {}): { context: PlanContext; power: MeasuredPower } => {
  const {
    total, headroom, headroomRaw, drawKw, headroomKw, capacityHeadroomKw, budgetHeadroomKw,
    capacityBreached, budgetReleasableHeadroomHold, ...contextOverrides
  } = spec;
  const context = buildPlanContextFixture(contextOverrides);
  const draw = drawKw ?? total ?? 3;
  const binding = headroomKw ?? headroom ?? headroomRaw ?? 0;
  return {
    context,
    power: buildMeasuredPower({
      drawKw: draw,
      headroomKw: binding,
      capacityHeadroomKw: capacityHeadroomKw ?? binding,
      budgetHeadroomKw: budgetHeadroomKw ?? null,
      capacityBreached: capacityBreached ?? draw > context.capacitySoftLimit,
      budgetReleasableHeadroomHold: budgetReleasableHeadroomHold ?? false,
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
