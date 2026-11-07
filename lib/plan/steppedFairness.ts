import type { PlanInputDevice } from './planTypes';

type FairnessDevice = Pick<PlanInputDevice, 'id' | 'priority'>;

/**
 * The priority rule shared by stepped selection, keep, restore and hold copy.
 * Callers establish which peers are limited or recovering from their stage's
 * facts. An active boost yields only to a peer ranked above it; otherwise any
 * limited peer counts. Priority 1 ranks highest. Power limits are independent.
 */
export function yieldsToLimitedDevice(
  device: FairnessDevice,
  boostActive: boolean,
  limitedDevice: FairnessDevice,
): boolean {
  return limitedDevice.id !== device.id
    && (!boostActive || limitedDevice.priority < device.priority);
}
