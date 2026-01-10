import type { HomeyDeviceLike } from '../utils/types';

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
