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
 * Whether an AC kWh of unforecast surplus stored in this period is worth more
 * than exporting it. Stored, it is worth the plan's value of usable stored
 * energy after charging loss; exported, the period's export price. An export
 * that earns nothing (unpriced, or a negative price) is never preferred.
 */
const storesSurplus = (battery: BatteryEnergyModel, period: BatteryEnergyPeriod): boolean => (
  period.exportPrice <= 0
  || period.exportPrice < battery.terminalValuePerKWh * Math.sqrt(battery.roundTripEfficiency)
);

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

/** The house's net AC demand in a period, kWh, with what earlier-planned batteries move. */
export const periodNetDemandKWh = (period: BatteryEnergyPeriod): number => (
  period.householdDemandKWh + period.otherManagedDemandKWh - period.solarKWh + period.otherStorageKWh
);

/** A transition the other way from the batteries planned before this one: one battery would feed another. */
const againstOtherStorage = (period: BatteryEnergyPeriod, acEnergyKWh: number): boolean => (
  (period.otherStorageKWh > ENERGY_EPSILON_KWH && acEnergyKWh < -ENERGY_EPSILON_KWH)
  || (period.otherStorageKWh < -ENERGY_EPSILON_KWH && acEnergyKWh > ENERGY_EPSILON_KWH)
);

/**
 * The most a transition may import, kWh. A charge stays within the limit; a
 * hold or supply may leave what later batteries can still supply above it.
 */
const importAllowanceKWh = (period: BatteryEnergyPeriod, acEnergyKWh: number): number => {
  const deferredKW = acEnergyKWh > ENERGY_EPSILON_KWH ? 0 : period.laterSupplyKW;
  return (period.gridImportLimitKW + deferredKW) * period.durationMs / HOUR_MS;
};

/** Import above the period's own limit, kWh, that a transition leaves for later batteries. */
export const deferredImportKWh = (period: BatteryEnergyPeriod, gridImportKWh: number): number => (
  Math.max(0, gridImportKWh - period.gridImportLimitKW * period.durationMs / HOUR_MS)
);

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
  const netDemandKWh = periodNetDemandKWh(period);
  const gridEnergyKWh = netDemandKWh + acEnergyKWh;
  if (againstOtherStorage(period, acEnergyKWh)) return false;
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
    || gridEnergyKWh > importAllowanceKWh(period, acEnergyKWh) + ENERGY_EPSILON_KWH) return false;
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
    storesSurplus: storesSurplus(battery, period),
  };
}
