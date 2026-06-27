import type { HomeyDeviceLike } from '../../utils/types';
import { isHomeBatteryDevice } from '../managerEnergy';

const SUPPORTED_DEVICE_CLASSES = new Set([
  'thermostat',
  'heater',
  'socket',
  'heatpump',
  'airconditioning',
  'airtreatment',
  // NB: home batteries are NOT listed here — `resolveDeviceClassKey` normalizes a
  // role-detected battery (class OR `homeBattery` energy role) to the 'battery'
  // class-key BEFORE this set check, so it survives regardless of its real class.
  // Batteries ride the snapshot as MANAGED OBSERVE-ONLY devices (resolved to
  // `controllable: false` + non-temperature, so every control gate excludes them).
  'evcharger',
]);

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
