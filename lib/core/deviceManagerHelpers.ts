import type { HomeyDeviceLike } from '../utils/types';

const SUPPORTED_DEVICE_CLASSES = new Set([
  'thermostat',
  'heater',
  'socket',
  'heatpump',
  'airconditioning',
  'airtreatment',
  'evcharger',
]);

export const getDeviceId = (device: HomeyDeviceLike): string | null => (
  device.id || device.data?.id || null
);

export const resolveDeviceClassKey = (params: {
  device: HomeyDeviceLike;
  experimentalEvSupportEnabled: boolean;
}): string | null => {
  const deviceClass = typeof params.device.class === 'string' && params.device.class.trim()
    ? params.device.class.trim()
    : null;
  if (!deviceClass) return null;
  const deviceClassKey = deviceClass.toLowerCase();
  if (!SUPPORTED_DEVICE_CLASSES.has(deviceClassKey)) return null;
  if (deviceClassKey === 'evcharger' && !params.experimentalEvSupportEnabled) return null;
  return deviceClassKey;
};

export const getCapabilities = (device: HomeyDeviceLike): string[] => (
  Array.isArray(device.capabilities) ? device.capabilities : []
);

export const getIsAvailable = (device: HomeyDeviceLike): boolean => (
  typeof device.available === 'boolean' ? device.available : true
);

export const resolveDeviceLabel = (device: HomeyDeviceLike, deviceId: string): string => (
  device.name ? `${device.name} (${deviceId})` : deviceId
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
