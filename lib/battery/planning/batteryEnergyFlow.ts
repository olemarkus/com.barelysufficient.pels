import type {
  BatteryEnergyModel,
  BatteryEnergyPeriod,
  BatteryEnergyPlanPeriod,
  BatteryEnergyReason,
} from '../../../packages/contracts/src/batteryPlan';

const HOUR_MS = 3_600_000;
export const ENERGY_EPSILON_KWH = 1e-9;

/** Battery-owner policy; the export ceiling is a resolved finite positive Main-meter kW bound. */
export type BatteryExportEconomicsPolicy = { kind: 'price_export'; netExportCeilingKW: number };
export type BatteryEnergyExportPolicy = { kind: 'household_only' } | BatteryExportEconomicsPolicy;

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
    || acEnergyKWh > Math.min(battery.maxChargeKW, period.maxChargeKW) * hours + ENERGY_EPSILON_KWH
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
    reason: reasonFor(acEnergyKWh, gridImportKWh),
  };
}
