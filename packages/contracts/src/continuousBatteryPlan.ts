import type { BatteryEnergyExportPolicy, BatteryEnergyPlan, BatteryPriceExportPolicy } from './batteryPlan.js';

/** The owner's explicit opt-in and battery economics, in the household price unit. */
export type ContinuousBatteryPlanConfig = {
  enabled: boolean;
  usableCapacityKWh: number;
  minimumReservePercent: number;
  roundTripEfficiency: number;
  wearCostPerKWh: number;
  /** Price unit in which the wear allowance was entered. A source-unit change requires review. */
  priceUnit: string;
  /** Whether PELS may sell stored energy. Absent in a stored legacy config, it resolves to household-only. */
  exportPolicy: BatteryEnergyExportPolicy;
};

export type ContinuousBatteryPlanConfigs = Record<string, ContinuousBatteryPlanConfig>;

export type ContinuousBatteryPlanWaitReason =
  | 'settings_unavailable'
  | 'battery_unavailable'
  | 'prices_unavailable'
  | 'forecast_unavailable'
  | 'solar_scope_shared'
  | 'background_unavailable'
  | 'control_unavailable'
  /** A participating smart task has not settled its plan, so its power is not yet known. */
  | 'smart_tasks_planning'
  | 'horizon_infeasible'
  | 'price_unit_changed';

/**
 * What the owner's price-export policy decided for this plan. Selling waits,
 * keeping the household plan, while export quotes are incomplete or the
 * comparison exceeds its work budget. `kept_household`: the comparison found no
 * strictly cheaper plan that sells. `selling`: the plan sells, with its
 * estimated net energy-cost reduction against household-only planning over the
 * same horizon and the same final stored energy.
 */
export type ContinuousBatteryExportDecision =
  | { kind: 'waiting'; reason: 'export_prices_incomplete' | 'evaluation_budget_exceeded' }
  | { kind: 'kept_household' }
  | { kind: 'selling'; estimatedSavings: number };

/** A config whose owner has not authorized selling. */
export type HouseholdOnlyBatteryPlanConfig = ContinuousBatteryPlanConfig & { exportPolicy: { kind: 'household_only' } };
/** A config whose owner authorized selling, with its Main-meter export ceiling. */
export type PriceExportBatteryPlanConfig = ContinuousBatteryPlanConfig & { exportPolicy: BatteryPriceExportPolicy };

type PlannedBatteryRead = {
  status: 'planned';
  generatedAtMs: number;
  priceUnit: string;
  plan: Extract<BatteryEnergyPlan, { status: 'planned' }>;
};

/**
 * A plan, and, only under a price-export policy, what selling decided: a
 * household-only plan carries no export decision at all, so a decision that
 * contradicts the policy cannot be expressed.
 */
export type PlannedContinuousBatteryRead =
  | PlannedBatteryRead & { config: HouseholdOnlyBatteryPlanConfig }
  | PlannedBatteryRead & { config: PriceExportBatteryPlanConfig; exportDecision: ContinuousBatteryExportDecision };

export type ContinuousBatteryPlanRead =
  | { status: 'disabled'; config: ContinuousBatteryPlanConfig }
  | { status: 'waiting'; config: ContinuousBatteryPlanConfig; reason: ContinuousBatteryPlanWaitReason }
  | PlannedContinuousBatteryRead;

/**
 * The battery owner's measurement of a battery's round-trip efficiency, offered
 * beside the configured value; the plan always uses the configured value.
 * `measuring` counts the accepted full cycles so far against the number a
 * suggestion needs; `unavailable` is a runtime
 * that has not started measuring (before wiring, or a store it cannot read).
 */
export type BatteryEfficiencyMeasurement =
  | { status: 'unavailable' }
  | { status: 'measuring'; cycles: number; cyclesNeeded: number }
  | { status: 'measured'; roundTripEfficiency: number; cycles: number };
