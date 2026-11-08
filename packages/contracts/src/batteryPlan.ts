/**
 * Resolved battery energy planning inputs. The battery-plan owner resolves SDK,
 * settings, price and forecast reads before constructing this horizon. Numbers
 * are finite, capacities/powers/energy non-negative, efficiency is in (0, 1],
 * reserve and observed stored energy are within usable capacity, and periods
 * have positive duration and are contiguous absolute instants.
 */
/**
 * A lower AC charge ceiling the battery has shown from this stored energy up:
 * many batteries accept less charge as they near full.
 */
export type BatteryChargeTaperStep = {
  fromEnergyKWh: number;
  maxChargeKW: number;
};

export type BatteryEnergyModel = {
  capacityKWh: number;
  storedEnergyKWh: number;
  minimumEnergyKWh: number;
  maxChargeKW: number;
  /**
   * Steps in ascending `fromEnergyKWh`. A transition's charge is capped by
   * every step at or below the stored energy it starts from, as well as by
   * `maxChargeKW`; empty when the battery has shown no taper.
   */
  chargeTaper: readonly BatteryChargeTaperStep[];
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
  /**
   * AC charging room after physical managed-power reservations, distinct from
   * their energy forecast, and after what the batteries planned before this one
   * charge. The battery's own ceiling applies separately.
   */
  maxChargeKW: number;
  /**
   * AC energy the batteries planned before this one move in this period:
   * positive charges them, negative supplies the house. It is part of this
   * battery's net demand, and it sets the period's direction: this battery
   * cannot supply while they charge, or charge while they supply, so no battery
   * feeds another. Zero for the first battery.
   */
  otherStorageKWh: number;
  /**
   * What the batteries planned after this one can still supply, kW. A period
   * this battery holds or supplies may leave up to this much import above
   * `gridImportLimitKW` for them to cover, at a penalty that makes this battery
   * cover what it can first. Zero for the last battery.
   */
  laterSupplyKW: number;
};

export type BatteryEnergyHorizon = {
  battery: BatteryEnergyModel;
  periods: readonly BatteryEnergyPeriod[];
};

/**
 * Why a period moves energy. `export_energy` is a discharge that sends battery
 * energy to the grid, which only a price-export policy can plan.
 */
export type BatteryEnergyReason = 'charge_grid' | 'store_solar' | 'supply_house' | 'hold_energy' | 'export_energy';

/** The owner's explicit authority to sell stored energy, with a finite positive Main-meter net-export ceiling, kW. */
export type BatteryPriceExportPolicy = { kind: 'price_export'; netExportCeilingKW: number };
/** Household-only planning, the default, never plans battery-driven export. */
export type BatteryEnergyExportPolicy = { kind: 'household_only' } | BatteryPriceExportPolicy;

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
  /**
   * Whether solar the forecast did not expect is worth storing in this period:
   * its export earns nothing, or less than the plan's value of the energy it
   * would store (`BatteryEnergyModel.terminalValuePerKWh` after charging
   * loss). Live control charges measured export into the battery in a supply
   * or hold period only when this holds.
   */
  storesSurplus: boolean;
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
