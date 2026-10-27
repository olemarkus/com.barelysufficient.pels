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
