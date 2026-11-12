import type { BatteryEnergyExportPolicy } from '../../../contracts/src/batteryPlan';
import type {
  ContinuousBatteryPlanConfig,
  ContinuousBatteryPlanConfigs,
} from '../../../contracts/src/continuousBatteryPlan';
import { isUnknownRecord } from '../recordGuards';

export const CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY = 'continuous_battery_plan';

/**
 * The price-unit label of a source that carries no currency (Flow prices), and
 * the form default before any prices were read. Flow prices and the wear
 * allowance the owner types are taken to be in the same unit.
 */
export const UNITLESS_PRICE_UNIT = 'price units';

/** Form defaults only: an absent setting never authorizes a plan or invents a battery capacity. */
export const DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG: ContinuousBatteryPlanConfig = {
  enabled: false,
  usableCapacityKWh: 10,
  minimumReservePercent: 20,
  roundTripEfficiency: 0.9,
  wearCostPerKWh: 0.03,
  priceUnit: UNITLESS_PRICE_UNIT,
  exportPolicy: { kind: 'household_only' },
};

/**
 * Whether a saved config's wear allowance was entered in the price unit it
 * names. Every enabled save is made in the unit the plan runs in, and a plan
 * turned off keeps that unit; only a config never turned on still holds the
 * form defaults, whose wear allowance belongs to no unit.
 */
export const isBatteryPlanUnitSettled = (config: ContinuousBatteryPlanConfig): boolean => (
  config.enabled || config.priceUnit.trim().toLowerCase() !== UNITLESS_PRICE_UNIT
);

/** The export ceiling's accepted range, kW: a positive Main-meter bound a home connection can carry. */
export const EXPORT_CEILING_MIN_KW = 0.1;
export const EXPORT_CEILING_MAX_KW = 100;

const inRange = (value: unknown, low: number, high: number): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
);

/**
 * A config written before selling existed has no policy: household-only. A
 * present policy must be complete; a malformed one is not quietly household-only.
 */
function parseExportPolicy(value: unknown): BatteryEnergyExportPolicy | null {
  if (value === undefined) return { kind: 'household_only' };
  if (!isUnknownRecord(value)) return null;
  if (value.kind === 'household_only') return { kind: 'household_only' };
  const ceilingKW = value.netExportCeilingKW;
  if (value.kind !== 'price_export' || !inRange(ceilingKW, EXPORT_CEILING_MIN_KW, EXPORT_CEILING_MAX_KW)) return null;
  return { kind: 'price_export', netExportCeilingKW: ceilingKW };
}

/** External settings/API boundary; no consumer reinterprets malformed battery economics. */
export function parseContinuousBatteryPlanConfig(value: unknown): ContinuousBatteryPlanConfig | null {
  if (!isUnknownRecord(value)
    || typeof value.enabled !== 'boolean'
    || !inRange(value.usableCapacityKWh, 0.1, 500)
    || !inRange(value.minimumReservePercent, 0, 95)
    || !inRange(value.roundTripEfficiency, 0.5, 1)
    || !inRange(value.wearCostPerKWh, 0, 1000)
    || typeof value.priceUnit !== 'string' || !value.priceUnit.trim() || value.priceUnit.length > 64) return null;
  const exportPolicy = parseExportPolicy(value.exportPolicy);
  if (exportPolicy === null) return null;
  return {
    enabled: value.enabled,
    usableCapacityKWh: value.usableCapacityKWh,
    minimumReservePercent: value.minimumReservePercent,
    roundTripEfficiency: value.roundTripEfficiency,
    wearCostPerKWh: value.wearCostPerKWh,
    priceUnit: value.priceUnit.trim(),
    exportPolicy,
  };
}

export function parseContinuousBatteryPlanConfigs(value: unknown): ContinuousBatteryPlanConfigs | null {
  if (!isUnknownRecord(value)) return null;
  const result: ContinuousBatteryPlanConfigs = {};
  for (const [deviceId, raw] of Object.entries(value)) {
    const config = parseContinuousBatteryPlanConfig(raw);
    if (!deviceId || config === null) return null;
    Object.defineProperty(result, deviceId, { value: config, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
