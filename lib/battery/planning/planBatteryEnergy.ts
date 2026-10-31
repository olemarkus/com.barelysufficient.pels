import type {
  BatteryEnergyHorizon,
  BatteryEnergyModel,
  BatteryEnergyPlan,
  BatteryEnergyPlanPeriod,
  BatteryEnergyPeriod,
} from '../../../packages/contracts/src/batteryPlan';
import {
  batteryEnergyFlow, ENERGY_EPSILON_KWH,
  type BatteryEnergyExportPolicy, type BatteryExportEconomicsPolicy,
} from './batteryEnergyFlow';

export type { BatteryExportEconomicsPolicy } from './batteryEnergyFlow';

type PlannedBatteryEnergy = Extract<BatteryEnergyPlan, { status: 'planned' }>;
type BatteryPlanFrontier =
  | { status: 'reachable'; routes: ReadonlyMap<number, Route> }
  | Extract<BatteryEnergyPlan, { status: 'infeasible' }>;

/** Diagnostic economics and export-period evidence only; never an executable plan or control permission. */
export type BatteryExportEconomicsComparison =
  | { kind: 'candidate_infeasible' }
  | {
    kind: 'compared';
    selection: 'household' | 'export_candidate';
    baselineEnergyCost: number;
    candidateEnergyCost: number;
    estimatedSavings: number;
    terminalEnergyKWh: number;
    exportPeriods: readonly {
      startsAtMs: number;
      durationMs: number;
      batteryPowerKW: number;
      batteryExportKWh: number;
    }[];
  };

/** Absolute numerical comparison tolerance in the horizon's money unit. */
const COST_COMPARISON_TOLERANCE = 1e-9;

/** 203 states at most, including exact initial energy and reserve. */
const ENERGY_INTERVALS = 200;

type Route =
  | { kind: 'start'; energyKWh: number; cost: number; throughputKWh: number }
  | {
    kind: 'step';
    energyKWh: number;
    cost: number;
    throughputKWh: number;
    flow: BatteryEnergyPlanPeriod;
    previous: Route;
  };

/**
 * The represented stored-energy states: the even grid (capacity / 200 kWh,
 * ascending) and then the exact initial energy and reserve when they fall off
 * it. This order is the visiting order, which settles equal-cost ties.
 */
type EnergyStates = { gridStepKWh: number; grid: readonly number[]; extra: readonly number[] };

const energyStates = (battery: BatteryEnergyModel): EnergyStates => {
  const grid = Array.from(
    { length: ENERGY_INTERVALS + 1 }, (_, index) => battery.capacityKWh * index / ENERGY_INTERVALS,
  );
  const onGrid = new Set(grid);
  const extra = [...new Set([battery.storedEnergyKWh, battery.minimumEnergyKWh])].filter(value => !onGrid.has(value));
  return { gridStepKWh: battery.capacityKWh / ENERGY_INTERVALS, grid, extra };
};

/**
 * Conservative work estimate for one solve, in attempted energy transitions.
 * Every represented origin may visit the entire reachable band plus exact
 * extra states. Ignoring demand, reserve and unreachable origins overestimates
 * work; this is a work-budget guard, not a wall-time guarantee.
 */
export function estimateBatteryEnergyTransitions(horizon: BatteryEnergyHorizon): number {
  const { battery } = horizon;
  const states = energyStates(battery);
  const originCount = states.grid.length + states.extra.length;
  const efficiency = Math.sqrt(battery.roundTripEfficiency);
  return horizon.periods.reduce((total, period) => {
    const hours = period.durationMs / 3_600_000;
    const chargeKWh = Math.max(0, Math.min(battery.maxChargeKW, period.maxChargeKW)) * hours * efficiency;
    const dischargeKWh = Math.max(0, battery.maxDischargeKW) * hours / efficiency;
    // reachableStates pads both ends by one state. An off-grid origin may
    // require one further rounded state, in addition to the inclusive end.
    const gridTargets = Math.min(
      states.grid.length, Math.ceil((chargeKWh + dischargeKWh) / states.gridStepKWh) + 4,
    );
    return total + originCount * (gridTargets + states.extra.length);
  }, 0);
}

/**
 * The states one period can reach from `beforeKWh`: a band of the grid wide
 * enough for its charge and discharge power, plus the extra states. The band
 * only skips states `batteryEnergyFlow` would reject on power alone; it still
 * judges every state it visits, in the same order as the full set.
 */
function* reachableStates(
  battery: BatteryEnergyModel,
  period: BatteryEnergyPeriod,
  states: EnergyStates,
  beforeKWh: number,
): Generator<number> {
  const hours = period.durationMs / 3_600_000;
  const efficiency = Math.sqrt(battery.roundTripEfficiency);
  const chargeKWh = Math.max(0, Math.min(battery.maxChargeKW, period.maxChargeKW)) * hours * efficiency;
  const dischargeKWh = Math.max(0, battery.maxDischargeKW) * hours / efficiency;
  const first = Math.max(0, Math.floor((beforeKWh - dischargeKWh) / states.gridStepKWh) - 1);
  const last = Math.min(states.grid.length - 1, Math.ceil((beforeKWh + chargeKWh) / states.gridStepKWh) + 1);
  for (const state of states.grid.slice(first, last + 1)) yield state;
  yield* states.extra;
}

const energyValue = (battery: BatteryEnergyModel, energyKWh: number): number => (
  Math.max(0, energyKWh - battery.minimumEnergyKWh) * battery.terminalValuePerKWh
);

const periodCost = (flow: BatteryEnergyPlanPeriod): number => flow.importCost - flow.exportRevenue + flow.wearCost;

const isBetter = (cost: number, throughputKWh: number, previous: Route | undefined): boolean => (
  previous === undefined
  || cost < previous.cost - ENERGY_EPSILON_KWH
  || (Math.abs(cost - previous.cost) <= ENERGY_EPSILON_KWH && throughputKWh < previous.throughputKWh)
);

function advancePeriod(
  battery: BatteryEnergyModel,
  period: BatteryEnergyPeriod,
  states: EnergyStates,
  current: ReadonlyMap<number, Route>,
  exportPolicy: BatteryEnergyExportPolicy,
): ReadonlyMap<number, Route> {
  const next = new Map<number, Route>();
  for (const before of current.values()) {
    for (const afterKWh of reachableStates(battery, period, states, before.energyKWh)) {
      const flow = batteryEnergyFlow(battery, period, before.energyKWh, afterKWh, exportPolicy);
      if (flow === false) continue;
      const cost = before.cost + periodCost(flow);
      const throughputKWh = before.throughputKWh + Math.abs(flow.batteryPowerKW) * period.durationMs / 3_600_000;
      if (!isBetter(cost, throughputKWh, next.get(afterKWh))) continue;
      next.set(afterKWh, { kind: 'step', energyKWh: afterKWh, cost, throughputKWh, flow, previous: before });
    }
  }
  return next;
}

function chooseTerminal(battery: BatteryEnergyModel, current: ReadonlyMap<number, Route>): Route {
  // The caller invokes this only with the reachable terminal frontier. The
  // initial state is itself reachable when the requested horizon is empty.
  let selected: Route | undefined;
  let selectedObjective = Infinity;
  for (const route of current.values()) {
    const objective = route.cost - energyValue(battery, route.energyKWh);
    if (selected === undefined || objective < selectedObjective - ENERGY_EPSILON_KWH
      || (Math.abs(objective - selectedObjective) <= ENERGY_EPSILON_KWH
        && route.throughputKWh < selected.throughputKWh)) {
      selected = route;
      selectedObjective = objective;
    }
  }
  if (selected === undefined) throw new Error('A battery plan terminal must be reachable.');
  return selected;
}

function materializePlan(battery: BatteryEnergyModel, terminal: Route): PlannedBatteryEnergy {
  // Each live frontier retains only its winning predecessor per energy state.
  // The route is unwound without mutating a shared plan or input horizon.
  const reversed = new Map<number, BatteryEnergyPlanPeriod>();
  let route = terminal;
  while (route.kind === 'step') {
    reversed.set(reversed.size, route.flow);
    route = route.previous;
  }
  const periods = Array.from(reversed.values()).reverse();
  const importCost = periods.reduce((sum, period) => sum + period.importCost, 0);
  const exportRevenue = periods.reduce((sum, period) => sum + period.exportRevenue, 0);
  const wearCost = periods.reduce((sum, period) => sum + period.wearCost, 0);
  const terminalEnergyValue = energyValue(battery, terminal.energyKWh);
  const energyCost = importCost - exportRevenue + wearCost;
  return {
    status: 'planned', periods, importCost, exportRevenue, wearCost, energyCost, terminalEnergyValue,
    objectiveCost: energyCost - terminalEnergyValue,
    terminalEnergyKWh: terminal.energyKWh,
    resolutionKWh: battery.capacityKWh / ENERGY_INTERVALS,
  };
}

/**
 * Lowest-cost path through a fixed stored-energy grid. This is a horizon-wide
 * dynamic program, not a cheap-period charging rule. Each period includes the
 * household's committed demand and AC import ceiling; battery export is never
 * admitted. Reserve, power, conversion loss, export opportunity cost, wear and
 * the configured value of usable energy beyond the horizon all affect choices.
 *
 * The optimum is over this represented grid (capacity / 200 kWh plus exact
 * observed energy/reserve), not a claim of continuous or forecast-perfect
 * optimality. Work is O(periods * 203 * reachable states per period), retained
 * routes O(periods * 203).
 * Short or constrained periods may have no feasible represented transition;
 * that returns an explicit outcome rather than fabricating a battery action.
 */
export function planBatteryEnergy(horizon: BatteryEnergyHorizon): BatteryEnergyPlan {
  const frontier = buildFrontier(horizon, { kind: 'household_only' });
  return frontier.status === 'infeasible'
    ? frontier
    : materializePlan(horizon.battery, chooseTerminal(horizon.battery, frontier.routes));
}

function buildFrontier(horizon: BatteryEnergyHorizon, exportPolicy: BatteryEnergyExportPolicy): BatteryPlanFrontier {
  const { battery } = horizon;
  const states = energyStates(battery);
  let current: ReadonlyMap<number, Route> = new Map([
    [battery.storedEnergyKWh, {
      kind: 'start', energyKWh: battery.storedEnergyKWh, cost: 0, throughputKWh: 0,
    }],
  ]);
  for (const period of horizon.periods) {
    current = advancePeriod(battery, period, states, current, exportPolicy);
    if (current.size === 0) {
      const netDemandKWh = period.householdDemandKWh + period.otherManagedDemandKWh - period.solarKWh;
      const absoluteSupplyKWh = (period.gridImportLimitKW + battery.maxDischargeKW) * period.durationMs / 3_600_000;
      return {
        status: 'infeasible', periodStartsAtMs: period.startsAtMs,
        reason: netDemandKWh > absoluteSupplyKWh ? 'power_limit' : 'reserve_or_power_limit',
      };
    }
  }
  return { status: 'reachable', routes: current };
}

/**
 * Compare a relaxed export solve with the household baseline from this exact
 * accepted horizon. Both solves use identical represented energy states. Fixing
 * the candidate's terminal to the baseline prevents liquidating initial stock
 * or a changed terminal credit from appearing as trading savings. The caller
 * has resolved complete export quotes; this result grants no control permission.
 */
export function compareBatteryExportEconomics(
  horizon: BatteryEnergyHorizon,
  policy: BatteryExportEconomicsPolicy,
  baseline: PlannedBatteryEnergy,
): BatteryExportEconomicsComparison {
  const frontier = buildFrontier(horizon, policy);
  if (frontier.status === 'infeasible') return { kind: 'candidate_infeasible' };
  const terminal = frontier.routes.get(baseline.terminalEnergyKWh);
  if (terminal === undefined) return { kind: 'candidate_infeasible' };
  const candidate = materializePlan(horizon.battery, terminal);
  const savings = baseline.energyCost - candidate.energyCost;
  const selected = savings > COST_COMPARISON_TOLERANCE;
  const exportPeriods = candidate.periods.flatMap(period => {
    const batterySupplyKWh = Math.max(0, -period.batteryPowerKW * period.durationMs / 3_600_000);
    const batteryExportKWh = Math.min(batterySupplyKWh, period.gridExportKWh);
    return batteryExportKWh > ENERGY_EPSILON_KWH ? [{
      startsAtMs: period.startsAtMs,
      durationMs: period.durationMs,
      batteryPowerKW: period.batteryPowerKW,
      batteryExportKWh,
    }] : [];
  });
  return {
    kind: 'compared', selection: selected ? 'export_candidate' : 'household',
    baselineEnergyCost: baseline.energyCost, candidateEnergyCost: candidate.energyCost,
    estimatedSavings: selected ? savings : 0, terminalEnergyKWh: candidate.terminalEnergyKWh,
    exportPeriods,
  };
}
