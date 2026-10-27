/**
 * Resolved battery energy planning inputs. The battery-plan owner resolves SDK,
 * settings, price and forecast reads before constructing this horizon. Numbers
 * are finite, capacities/powers/energy non-negative, efficiency is in (0, 1],
 * reserve and observed stored energy are within usable capacity, and periods
 * have positive duration and are contiguous absolute instants.
 */
export type BatteryEnergyModel = {
  capacityKWh: number;
  storedEnergyKWh: number;
  minimumEnergyKWh: number;
  maxChargeKW: number;
  maxDischargeKW: number;
  roundTripEfficiency: number;
  /** Allowance per AC kWh supplied by the battery. Same currency as prices. */
  wearCostPerKWh: number;
  /** Value of one usable DC kWh left above reserve at the horizon end. */
  terminalValuePerKWh: number;
};

export type BatteryEnergyPeriod = {
  startsAtMs: number;
  durationMs: number;
  importPrice: number;
  exportPrice: number;
  /** Gross house demand excluding both the battery and managed commitments. */
  householdDemandKWh: number;
  /** Already allocated managed commitments, including EV smart tasks. */
  otherManagedDemandKWh: number;
  solarKWh: number;
  gridImportLimitKW: number;
  /** AC charging room after physical managed-power reservations, distinct from their energy forecast. */
  maxChargeKW: number;
};

export type BatteryEnergyHorizon = {
  battery: BatteryEnergyModel;
  periods: readonly BatteryEnergyPeriod[];
};

export type BatteryEnergyReason = 'charge_grid' | 'store_solar' | 'supply_house' | 'hold_energy';

export type BatteryEnergyPlanPeriod = {
  startsAtMs: number;
  durationMs: number;
  /** AC power: positive charges the battery, negative supplies the house. */
  batteryPowerKW: number;
  energyBeforeKWh: number;
  energyAfterKWh: number;
  gridImportKWh: number;
  gridExportKWh: number;
  importCost: number;
  exportRevenue: number;
  wearCost: number;
  reason: BatteryEnergyReason;
};

export type BatteryEnergyPlan =
  | {
    status: 'planned';
    periods: readonly BatteryEnergyPlanPeriod[];
    importCost: number;
    exportRevenue: number;
    wearCost: number;
    energyCost: number;
    terminalEnergyValue: number;
    objectiveCost: number;
    terminalEnergyKWh: number;
    /** Discretization of stored energy; exact initial energy and reserve are also represented. */
    resolutionKWh: number;
  }
  | {
    status: 'infeasible';
    periodStartsAtMs: number;
    /** No represented trajectory can respect the import, power and reserve constraints. */
    reason: 'power_limit' | 'reserve_or_power_limit';
  };
