import type { BatteryEnergyPlan } from './batteryPlan.js';

/** The owner's explicit opt-in and battery economics, in the household price unit. */
export type ContinuousBatteryPlanConfig = {
  enabled: boolean;
  usableCapacityKWh: number;
  minimumReservePercent: number;
  roundTripEfficiency: number;
  wearCostPerKWh: number;
  /** Price unit in which the wear allowance was entered. A source-unit change requires review. */
  priceUnit: string;
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

export type ContinuousBatteryPlanRead =
  | { status: 'disabled'; config: ContinuousBatteryPlanConfig }
  | { status: 'waiting'; config: ContinuousBatteryPlanConfig; reason: ContinuousBatteryPlanWaitReason }
  | {
    status: 'planned';
    config: ContinuousBatteryPlanConfig;
    generatedAtMs: number;
    priceUnit: string;
    plan: Extract<BatteryEnergyPlan, { status: 'planned' }>;
  };

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
