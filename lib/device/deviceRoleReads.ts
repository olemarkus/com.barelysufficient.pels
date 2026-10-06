/**
 * The deviceId-only answers about a device's energy role (home battery or
 * solar device) and its Managed state, for callers that hold no device object:
 * flow-card autocomplete, the shortfall hint, realtime tracking, the mode
 * priority catalog. The device layer is the one source of both role sets
 * (`batteryStateProducer.ts`, `solarProductionProducer.ts`).
 *
 * `transport` is absent in the boot window before the device layer exists.
 * Then no device is known by role: the Managed answer falls through to the
 * managed-devices map, as it would for any device the layer has not seen, and
 * the battery set reads `unavailable` rather than empty.
 */
import type { HomeBatteryDevicesRead } from '../ports/homeBatteryDevices';
import type { BatteryManagedRead } from '../ports/batteryControlOwner';
import type { DeviceTransportPort } from './deviceTransport';

type DeviceRoles = Pick<DeviceTransportPort, 'isBatteryDevice' | 'isSolarDevice' | 'readHomeBatteryDevices'>;

const UNAVAILABLE: HomeBatteryDevicesRead = { status: 'unavailable' };

/** A home battery or a solar device: never a load the generic shed/restore lanes command. */
export function isBatteryOrSolarDeviceId(transport: DeviceRoles | undefined, deviceId: string): boolean {
  return transport !== undefined && (transport.isBatteryDevice(deviceId) || transport.isSolarDevice(deviceId));
}

/**
 * Whether the owner has this device managed. A solar device is always read. A
 * home battery's Managed choice is the battery control setting, answered by
 * `lib/battery` (absent = on, unreadable = off). Any other device: the
 * managed-devices map.
 */
export function resolveDeviceManagedState(
  transport: DeviceRoles | undefined,
  batteryManaged: BatteryManagedRead,
  managedDevices: Readonly<Record<string, boolean>>,
  deviceId: string,
): boolean {
  if (transport?.isSolarDevice(deviceId) === true) return true;
  if (transport?.isBatteryDevice(deviceId) === true) return batteryManaged.isManaged(deviceId);
  return managedDevices[deviceId] === true;
}

/** The detected home batteries, `unavailable` before the device layer exists or has settled them. */
export function readHomeBatteryDevices(transport: DeviceRoles | undefined): HomeBatteryDevicesRead {
  return transport === undefined ? UNAVAILABLE : transport.readHomeBatteryDevices();
}
