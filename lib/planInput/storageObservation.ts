import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';

/**
 * Accepted signed battery power in one home, independent of control permission.
 * Membership scopes the roster first. An unavailable/unread battery is omitted
 * so the planner can still reserve a held discharge it has not seen stop.
 * Only batteries carry `batteryPower`; charging remains an explicit observation
 * rather than cancelling another battery's discharge or looking unread.
 */
export function projectObservedBatteryPowerW(devices: readonly DeviceSurfaces[]): ReadonlyMap<string, number> {
  return new Map(devices.flatMap((device) => (
    device.available && device.batteryPower !== undefined
      ? [[device.id, device.batteryPower.signedW] as const] : []
  )));
}
