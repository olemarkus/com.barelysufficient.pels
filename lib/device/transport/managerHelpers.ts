import type { HomeyDeviceLike } from '../../utils/types';
import { isHomeBatteryDevice, isSolarPanelDevice } from '../managerEnergy';

const SUPPORTED_DEVICE_CLASSES = new Set([
  'thermostat',
  'heater',
  'socket',
  'heatpump',
  'airconditioning',
  'airtreatment',
  // NB: home batteries and solar devices are NOT listed here — `resolveDeviceClassKey`
  // normalizes a role-detected battery (class OR `homeBattery` energy role) to the
  // 'battery' class-key and a role-detected solar device (class:'solarpanel' OR the
  // `meterPowerExportedCapability` producer designation) to the 'solarpanel' class-key
  // BEFORE this set check, so each survives regardless of its real class. Both ride the
  // snapshot as MANAGED OBSERVE-ONLY devices (resolved to `controllable: false` +
  // non-temperature, so every control gate excludes them).
  'evcharger',
]);

// The normalized class-keys that `resolveDeviceClassKey` assigns to the two
// observe-only ROLES (battery → 'battery', solar → 'solarpanel'). PELS tracks but
// never controls a device with one of these class-keys: it is kept as a power-capable,
// non-controllable, non-temperature snapshot entry and excluded from flow-backed
// control. Consumers that only have a `deviceClassKey` string in hand (the capability
// branch, the managed-filter ui_picker drop, the flow-card guard) match on this set so
// battery + solar share the same observe-only treatment from one definition.
const OBSERVE_ONLY_ROLE_CLASS_KEYS = new Set(['battery', 'solarpanel']);

export const isObserveOnlyRoleClassKey = (deviceClassKey: string | undefined): boolean => (
  deviceClassKey !== undefined && OBSERVE_ONLY_ROLE_CLASS_KEYS.has(deviceClassKey)
);

export const getDeviceId = (device: HomeyDeviceLike): string => device.id;

export const resolveDeviceClassKey = (device: HomeyDeviceLike): string | null => {
  // Normalize EVERY role-detected home battery to the 'battery' class-key — by class
  // OR the canonical `homeBattery` energy role — at this single point. This makes
  // detection (`isHomeBatteryDevice`) and snapshot SURVIVAL use the SAME predicate:
  // an energy-role-only battery (whose real `class` may be 'sensor'/'other', not in
  // the supported set) still resolves to 'battery', so it survives identity and every
  // downstream `deviceClassKey === 'battery'` gate fires consistently. A battery is
  // then stamped managed observe-only structurally in `resolveParsedDeviceSettings`.
  if (isHomeBatteryDevice(device)) return 'battery';
  // Same machinery for a role-detected solar device — by class:'solarpanel' OR the
  // `meterPowerExportedCapability` producer designation — normalized to the
  // 'solarpanel' class-key so an energy-role-only PV (real class 'sensor'/'other')
  // also survives identity and every downstream `deviceClassKey === 'solarpanel'`
  // gate fires. Stamped managed observe-only structurally in `resolveParsedDeviceSettings`.
  if (isSolarPanelDevice(device)) return 'solarpanel';
  const deviceClass = typeof device.class === 'string' ? device.class.trim() : '';
  if (!deviceClass) return null;
  const deviceClassKey = deviceClass.toLowerCase();
  if (!SUPPORTED_DEVICE_CLASSES.has(deviceClassKey)) return null;
  return deviceClassKey;
};

export const getCapabilities = (device: HomeyDeviceLike): string[] => (
  Array.isArray(device.capabilities) ? device.capabilities : []
);

export const getIsAvailable = (device: HomeyDeviceLike): boolean => (
  typeof device.available === 'boolean' ? device.available : true
);

export const resolveDeviceLabel = (device: HomeyDeviceLike, deviceId: string): string => (
  `${device.name} (${deviceId})`
);

export const resolveZoneLabel = (device: HomeyDeviceLike): string => {
  const zone = device.zone;
  if (zone && typeof zone === 'object' && 'name' in zone) {
    const name = (zone as { name?: unknown }).name;
    if (typeof name === 'string' && name) {
      return name;
    }
  }
  if (typeof zone === 'string' && zone) {
    return zone;
  }
  const zoneName = device.zoneName;
  if (typeof zoneName === 'string' && zoneName) {
    return zoneName;
  }
  return 'Unknown';
};
