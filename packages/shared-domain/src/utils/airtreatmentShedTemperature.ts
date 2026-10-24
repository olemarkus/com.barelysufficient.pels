import {
  AIRTREATMENT_SHED_FLOOR_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
  SHED_STEP_C,
} from './airtreatmentConstants';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types';
import { getPrimaryTargetCapability } from '../targetCapabilities';
import { HEATING_SHED_LIMIT_RANGE } from '../settings/shedBehaviors';
import { clamp } from './math';

export function normalizeShedTemperature(value: number): number {
  const clamped = clamp(value, HEATING_SHED_LIMIT_RANGE.minC, HEATING_SHED_LIMIT_RANGE.maxC);
  return Math.round(clamped / SHED_STEP_C) * SHED_STEP_C;
}

/**
 * The device's configured minimum target, also its automatic heating limit.
 * Accepted capability metadata already contains finite numbers. When Homey
 * supplies no minimum, retain the class-specific PELS fallback.
 */
export function resolveSetpointShedFloorC(device: Pick<TargetDeviceSnapshot, 'deviceClass' | 'targets'>): number {
  const target = getPrimaryTargetCapability(device.targets);
  if (target?.min !== undefined) return target.min;
  return device.deviceClass.trim().toLowerCase() === 'airtreatment'
    ? AIRTREATMENT_SHED_FLOOR_C
    : NON_ONOFF_TEMPERATURE_SHED_FLOOR_C;
}
