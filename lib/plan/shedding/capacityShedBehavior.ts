import type { PlanInputDevice, ShedBehavior } from '../planTypes';

/** The installation's ladder includes a switch pause at its floor. */
export function resolveCapacityShedBehavior(
  device: PlanInputDevice, getShedBehavior: (deviceId: string) => ShedBehavior,
): ShedBehavior {
  return device.chargingInstallationLoad ? { action: 'turn_off' } : getShedBehavior(device.id);
}
