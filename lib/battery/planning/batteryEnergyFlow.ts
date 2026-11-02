import type {
  BatteryEnergyExportPolicy,
  BatteryEnergyModel,
  BatteryEnergyPeriod,
  BatteryEnergyPlanPeriod,
  BatteryEnergyReason,
} from '../../../packages/contracts/src/batteryPlan';

const HOUR_MS = 3_600_000;
export const ENERGY_EPSILON_KWH = 1e-9;

/**
 * A discharge whose energy reaches the grid is an export; one the house uses
 * is household supply. Household-only planning can never export battery
 * energy: its discharge allowance is bounded by net demand.
 */
const reasonFor = (batteryEnergyKWh: number, gridImportKWh: number, gridExportKWh: number): BatteryEnergyReason => {
  if (batteryEnergyKWh < -ENERGY_EPSILON_KWH) {
    return Math.min(-batteryEnergyKWh, gridExportKWh) > ENERGY_EPSILON_KWH ? 'export_energy' : 'supply_house';
  }
  if (batteryEnergyKWh <= ENERGY_EPSILON_KWH) return 'hold_energy';
  return gridImportKWh > ENERGY_EPSILON_KWH ? 'charge_grid' : 'store_solar';
};

/**
 * The most AC charge, kW, a transition starting at `beforeKWh` may take: the
 * battery and period ceilings, and every taper step at or below that energy.
 * A period's charge is capped by the energy it starts from, not its path.
 */
export function chargeLimitKW(battery: BatteryEnergyModel, period: BatteryEnergyPeriod, beforeKWh: number): number {
  let limitKW = Math.min(battery.maxChargeKW, period.maxChargeKW);
  for (const step of battery.chargeTaper) {
    if (step.fromEnergyKWh > beforeKWh + ENERGY_EPSILON_KWH) break;
    limitKW = Math.min(limitKW, step.maxChargeKW);
  }
  return Math.max(0, limitKW);
}

/**
 * Evaluate one represented storage transition, or reject it. Both directions
 * include conversion loss. An already-below-reserve battery can hold or charge
 * but cannot discharge further; once above reserve that floor applies normally.
 */
export function batteryEnergyFlow(
  battery: BatteryEnergyModel,
  period: BatteryEnergyPeriod,
  beforeKWh: number,
  afterKWh: number,
  exportPolicy: BatteryEnergyExportPolicy,
): BatteryEnergyPlanPeriod | false {
  const hours = period.durationMs / HOUR_MS;
  const deltaKWh = afterKWh - beforeKWh;
  const efficiency = Math.sqrt(battery.roundTripEfficiency);
  const acEnergyKWh = deltaKWh >= 0 ? deltaKWh / efficiency : deltaKWh * efficiency;
  const netDemandKWh = period.householdDemandKWh + period.otherManagedDemandKWh - period.solarKWh;
  const gridEnergyKWh = netDemandKWh + acEnergyKWh;
  // Independent solar export may already exceed the ceiling. Holding or charging
  // stays feasible, but discharge cannot worsen that excess. Nonpositive prices
  // prohibit battery-added export, without prohibiting household supply.
  const exportAllowanceKWh = exportPolicy.kind === 'price_export' && period.exportPrice > 0
    ? exportPolicy.netExportCeilingKW * hours
    : 0;
  const dischargeAllowanceKWh = Math.max(0, netDemandKWh + exportAllowanceKWh);
  const reserveFloorKWh = Math.min(battery.minimumEnergyKWh, beforeKWh);
  if (afterKWh < reserveFloorKWh - ENERGY_EPSILON_KWH
    || acEnergyKWh > chargeLimitKW(battery, period, beforeKWh) * hours + ENERGY_EPSILON_KWH
    || -acEnergyKWh > battery.maxDischargeKW * hours + ENERGY_EPSILON_KWH
    || -acEnergyKWh > dischargeAllowanceKWh + ENERGY_EPSILON_KWH
    || gridEnergyKWh > period.gridImportLimitKW * hours + ENERGY_EPSILON_KWH) return false;
  const gridImportKWh = Math.max(0, gridEnergyKWh);
  const gridExportKWh = Math.max(0, -gridEnergyKWh);
  return {
    startsAtMs: period.startsAtMs,
    durationMs: period.durationMs,
    batteryPowerKW: acEnergyKWh / hours,
    energyBeforeKWh: beforeKWh,
    energyAfterKWh: afterKWh,
    gridImportKWh,
    gridExportKWh,
    importCost: gridImportKWh * period.importPrice,
    exportRevenue: gridExportKWh * period.exportPrice,
    wearCost: Math.max(0, -acEnergyKWh) * battery.wearCostPerKWh,
    reason: reasonFor(acEnergyKWh, gridImportKWh, gridExportKWh),
  };
}
