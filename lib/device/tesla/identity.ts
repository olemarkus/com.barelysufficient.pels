import type { HomeyDeviceLike } from '../../utils/types';

const TESLA_APP_URI = 'homey:app:com.tesla.car';

/** Homey supplies either a qualified driver ID or an app URI and local ID. */
export function teslaDriver(device: HomeyDeviceLike): string | undefined {
  const id = device.driverId ?? device.driver?.id;
  if (!id) return undefined;
  if (id.includes(':')) {
    return id.startsWith(`${TESLA_APP_URI}:`) ? id.slice(TESLA_APP_URI.length + 1) : undefined;
  }
  return (device.driverUri ?? device.driver?.uri) === TESLA_APP_URI ? id : undefined;
}

export function isTeslaChargingDevice(device: HomeyDeviceLike): boolean {
  // The driver owns the role. A rejected observation removes only its field,
  // never the battery device's charging identity or its usable sibling fields.
  return teslaDriver(device) === 'battery';
}
