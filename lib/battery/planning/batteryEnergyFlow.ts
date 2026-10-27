import type {
  BatteryEnergyModel,
  BatteryEnergyPeriod,
  BatteryEnergyPlanPeriod,
  BatteryEnergyReason,
} from '../../../packages/contracts/src/batteryPlan';

const HOUR_MS = 3_600_000;
export const ENERGY_EPSILON_KWH = 1e-9;

const reasonFor = (batteryEnergyKWh: number, gridImportKWh: number): BatteryEnergyReason => {
  if (batteryEnergyKWh < -ENERGY_EPSILON_KWH) return 'supply_house';
  if (batteryEnergyKWh <= ENERGY_EPSILON_KWH) return 'hold_energy';
  return gridImportKWh > ENERGY_EPSILON_KWH ? 'charge_grid' : 'store_solar';
};

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
): BatteryEnergyPlanPeriod | false {
  const hours = period.durationMs / HOUR_MS;
  const deltaKWh = afterKWh - beforeKWh;
  const efficiency = Math.sqrt(battery.roundTripEfficiency);
  const acEnergyKWh = deltaKWh >= 0 ? deltaKWh / efficiency : deltaKWh * efficiency;
  const netDemandKWh = period.householdDemandKWh + period.otherManagedDemandKWh - period.solarKWh;
  const gridEnergyKWh = netDemandKWh + acEnergyKWh;
  const reserveFloorKWh = Math.min(battery.minimumEnergyKWh, beforeKWh);
  if (afterKWh < reserveFloorKWh - ENERGY_EPSILON_KWH
    || acEnergyKWh > Math.min(battery.maxChargeKW, period.maxChargeKW) * hours + ENERGY_EPSILON_KWH
    || -acEnergyKWh > battery.maxDischargeKW * hours + ENERGY_EPSILON_KWH
    || -acEnergyKWh > Math.max(0, netDemandKWh) + ENERGY_EPSILON_KWH
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
    reason: reasonFor(acEnergyKWh, gridImportKWh),
  };
}
