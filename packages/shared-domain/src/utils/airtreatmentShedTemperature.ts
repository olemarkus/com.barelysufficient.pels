import {
  AIRTREATMENT_SHED_FLOOR_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
  SETPOINT_SHED_DEFAULT_MAX_C,
  SHED_DEFAULT_DELTA_C,
  SHED_FALLBACK_TARGET_C,
  SHED_STEP_C,
} from './airtreatmentConstants';
import { HEATING_SHED_LIMIT_RANGE } from '../settings/shedBehaviors';
import { clamp } from './math';

const roundToShedStep = (value: number): number => Math.round(value / SHED_STEP_C) * SHED_STEP_C;

/**
 * A saved heating limit, in the key's range and on the editor's step. The
 * device's own target range bounds what is written.
 */
export function normalizeShedTemperature(value: number): number {
  return roundToShedStep(clamp(value, HEATING_SHED_LIMIT_RANGE.minC, HEATING_SHED_LIMIT_RANGE.maxC));
}

/**
 * The heating limit for a device whose setpoint is its only way to shed, when
 * the owner saved none: its mode target (a fixed base without one) less the
 * default setback, never below `minFloorC` and never above
 * `SETPOINT_SHED_DEFAULT_MAX_C`. Never from the live setpoint, which is the
 * limit itself while the device is limited.
 */
export function computeDefaultSetpointShedTemperature(modeTargetC: number | null, minFloorC: number): number {
  const candidate = Math.max(minFloorC, (modeTargetC ?? SHED_FALLBACK_TARGET_C) - SHED_DEFAULT_DELTA_C);
  return roundToShedStep(Math.min(SETPOINT_SHED_DEFAULT_MAX_C, candidate));
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
