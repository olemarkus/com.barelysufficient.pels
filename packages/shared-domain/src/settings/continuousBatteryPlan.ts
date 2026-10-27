import type {
  ContinuousBatteryPlanConfig,
  ContinuousBatteryPlanConfigs,
} from '../../../contracts/src/continuousBatteryPlan';
import { isUnknownRecord } from '../recordGuards';

export const CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY = 'continuous_battery_plan';

/** Form defaults only: an absent setting never authorizes a plan or invents a battery capacity. */
export const DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG: ContinuousBatteryPlanConfig = {
  enabled: false,
  usableCapacityKWh: 10,
  minimumReservePercent: 20,
  roundTripEfficiency: 0.9,
  wearCostPerKWh: 0.03,
  priceUnit: 'price units',
};

const inRange = (value: unknown, low: number, high: number): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
);

/** External settings/API boundary; no consumer reinterprets malformed battery economics. */
export function parseContinuousBatteryPlanConfig(value: unknown): ContinuousBatteryPlanConfig | null {
  if (!isUnknownRecord(value)
    || typeof value.enabled !== 'boolean'
    || !inRange(value.usableCapacityKWh, 0.1, 500)
    || !inRange(value.minimumReservePercent, 0, 95)
    || !inRange(value.roundTripEfficiency, 0.5, 1)
    || !inRange(value.wearCostPerKWh, 0, 1000)
    || typeof value.priceUnit !== 'string' || !value.priceUnit.trim() || value.priceUnit.length > 64
    || (value.enabled && value.priceUnit.trim().toLowerCase() === 'price units')) return null;
  return {
    enabled: value.enabled,
    usableCapacityKWh: value.usableCapacityKWh,
    minimumReservePercent: value.minimumReservePercent,
    roundTripEfficiency: value.roundTripEfficiency,
    wearCostPerKWh: value.wearCostPerKWh,
    priceUnit: value.priceUnit.trim(),
  };
}

export function parseContinuousBatteryPlanConfigs(value: unknown): ContinuousBatteryPlanConfigs | null {
  if (!isUnknownRecord(value)) return null;
  const result: ContinuousBatteryPlanConfigs = {};
  let enabledCount = 0;
  for (const [deviceId, raw] of Object.entries(value)) {
    const config = parseContinuousBatteryPlanConfig(raw);
    if (!deviceId || config === null) return null;
    if (config.enabled) enabledCount += 1;
    if (enabledCount > 1) return null;
    Object.defineProperty(result, deviceId, { value: config, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
