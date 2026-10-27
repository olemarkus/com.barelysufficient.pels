import type {
  BatteryEnergyHorizon,
  BatteryEnergyModel,
  BatteryEnergyPlan,
  BatteryEnergyPlanPeriod,
  BatteryEnergyPeriod,
} from '../../../packages/contracts/src/batteryPlan';
import { batteryEnergyFlow, ENERGY_EPSILON_KWH } from './batteryEnergyFlow';

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

const energyStates = (battery: BatteryEnergyModel): readonly number[] => Array.from(new Set([
  ...Array.from({ length: ENERGY_INTERVALS + 1 }, (_, index) => battery.capacityKWh * index / ENERGY_INTERVALS),
  battery.storedEnergyKWh,
  battery.minimumEnergyKWh,
]));

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
  states: readonly number[],
  current: ReadonlyMap<number, Route>,
): ReadonlyMap<number, Route> {
  const next = new Map<number, Route>();
  for (const before of current.values()) {
    for (const afterKWh of states) {
      const flow = batteryEnergyFlow(battery, period, before.energyKWh, afterKWh);
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

function materializePlan(battery: BatteryEnergyModel, terminal: Route): BatteryEnergyPlan {
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
 * optimality. Work is O(periods * 203²), retained routes O(periods * 203).
 * Short or constrained periods may have no feasible represented transition;
 * that returns an explicit outcome rather than fabricating a battery action.
 */
export function planBatteryEnergy(horizon: BatteryEnergyHorizon): BatteryEnergyPlan {
  const { battery } = horizon;
  const states = energyStates(battery);
  let current: ReadonlyMap<number, Route> = new Map([
    [battery.storedEnergyKWh, {
      kind: 'start', energyKWh: battery.storedEnergyKWh, cost: 0, throughputKWh: 0,
    }],
  ]);
  for (const period of horizon.periods) {
    current = advancePeriod(battery, period, states, current);
    if (current.size === 0) {
      const netDemandKWh = period.householdDemandKWh + period.otherManagedDemandKWh - period.solarKWh;
      const absoluteSupplyKWh = (period.gridImportLimitKW + battery.maxDischargeKW) * period.durationMs / 3_600_000;
      return {
        status: 'infeasible', periodStartsAtMs: period.startsAtMs,
        reason: netDemandKWh > absoluteSupplyKWh ? 'power_limit' : 'reserve_or_power_limit',
      };
    }
  }
  return materializePlan(battery, chooseTerminal(battery, current));
}
