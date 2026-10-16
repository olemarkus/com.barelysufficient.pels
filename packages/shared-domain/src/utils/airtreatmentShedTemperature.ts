import {
  AIRTREATMENT_SHED_FLOOR_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
  SHED_DEFAULT_DELTA_C,
  SHED_FALLBACK_TARGET_C,
  SHED_MAX_C,
  SHED_MIN_C,
  SHED_STEP_C,
} from './airtreatmentConstants';

export function normalizeShedTemperature(value: number): number {
  const clamped = Math.max(SHED_MIN_C, Math.min(SHED_MAX_C, value));
  return Math.round(clamped / SHED_STEP_C) * SHED_STEP_C;
}

/**
 * The heating limit for a device whose setpoint is its only way to shed, when
 * the owner saved none: its mode target (a fixed base without one) less the
 * default setback, never below `minFloorC`. Never from the live setpoint, which
 * is the limit itself while the device is limited.
 */
export function computeDefaultSetpointShedTemperature(modeTargetC: number | null, minFloorC: number): number {
  const candidate = Math.max(minFloorC, (modeTargetC ?? SHED_FALLBACK_TARGET_C) - SHED_DEFAULT_DELTA_C);
  return normalizeShedTemperature(candidate);
}

/**
 * The lowest heating limit for a device whose setpoint is its only way to shed
 * (no on/off, no steps), by its Homey class: air treatment sets supply air, so
 * it stops higher. Case-insensitive.
 */
export function resolveSetpointShedFloorC(deviceClass: string): number {
  return deviceClass.trim().toLowerCase() === 'airtreatment'
    ? AIRTREATMENT_SHED_FLOOR_C
    : NON_ONOFF_TEMPERATURE_SHED_FLOOR_C;
}
