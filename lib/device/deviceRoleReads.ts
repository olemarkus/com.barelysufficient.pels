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
import type { DeviceControlSettings } from './deviceControlSettings';

type DeviceRoles = Pick<DeviceTransportPort, 'isBatteryDevice' | 'isSolarDevice' | 'readHomeBatteryDevices'>;
/** The role sets the device layer detected: which ids are home batteries and solar devices. */
export type DeviceRoleMembership = Pick<DeviceRoles, 'isBatteryDevice' | 'isSolarDevice'>;

const UNAVAILABLE: HomeBatteryDevicesRead = { status: 'unavailable' };

/** A home battery or a solar device: never a load the generic shed/restore lanes command. */
export function isBatteryOrSolarDeviceId(transport: DeviceRoleMembership | undefined, deviceId: string): boolean {
  return transport !== undefined && (transport.isBatteryDevice(deviceId) || transport.isSolarDevice(deviceId));
}

/**
 * Whether the owner has this device managed. A solar device is always read. A
 * home battery's Managed choice is the battery control setting, answered by
 * `lib/battery` (absent = on, unreadable = off). Any other device: the
 * managed-devices map.
 */
export function resolveDeviceManagedState(
  transport: DeviceRoleMembership | undefined,
  batteryManaged: BatteryManagedRead,
  settings: Pick<DeviceControlSettings, 'isManaged'>,
  deviceId: string,
): boolean {
  if (transport?.isSolarDevice(deviceId) === true) return true;
  if (transport?.isBatteryDevice(deviceId) === true) return batteryManaged.isManaged(deviceId);
  return settings.isManaged(deviceId);
}

/**
 * Whether Power-limit control is on for a device: an ordinary device the owner
 * has both managed and put under control. Never a home battery or a solar
 * device; the storage lane commands a battery.
 */
export function resolveCapacityControlEnabled(
  transport: DeviceRoleMembership | undefined,
  settings: Pick<DeviceControlSettings, 'isManaged' | 'isControllable'>,
  deviceId: string,
): boolean {
  return !isBatteryOrSolarDeviceId(transport, deviceId)
    && settings.isManaged(deviceId)
    && settings.isControllable(deviceId);
}

/** The detected home batteries, `unavailable` before the device layer exists or has settled them. */
export function readHomeBatteryDevices(transport: DeviceRoles | undefined): HomeBatteryDevicesRead {
  return transport === undefined ? UNAVAILABLE : transport.readHomeBatteryDevices();
}

/**
 * Whether the owner manages a device, and has Power-limit control on for it,
 * answered from the device layer's own role knowledge. The transport builds one
 * over its role producers; the parse reads it rather than three loose inputs.
 */
export class DeviceManagement {
  constructor(
    private readonly roles: DeviceRoleMembership,
    private readonly batteryManaged: BatteryManagedRead,
    private readonly settings: Pick<DeviceControlSettings, 'isManaged' | 'isControllable' | 'isManagedFilterActive'>,
  ) {}

  isManaged(deviceId: string): boolean {
    return resolveDeviceManagedState(this.roles, this.batteryManaged, this.settings, deviceId);
  }

  isCapacityControlEnabled(deviceId: string): boolean {
    return resolveCapacityControlEnabled(this.roles, this.settings, deviceId);
  }

  isManagedFilterActive(): boolean {
    return this.settings.isManagedFilterActive();
  }
}
