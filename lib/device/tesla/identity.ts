import type { HomeyDeviceLike } from '../../utils/types';

const TESLA_APP_URI = 'homey:app:com.tesla.car';

/** A driver override may name the local ID alone, with the app in `ownerUri`. */
export function teslaDriver(device: HomeyDeviceLike): string | undefined {
  const id = device.driverId;
  if (id.includes(':')) {
    return id.startsWith(`${TESLA_APP_URI}:`) ? id.slice(TESLA_APP_URI.length + 1) : undefined;
  }
  return device.ownerUri === TESLA_APP_URI ? id : undefined;
}

export function isTeslaChargingDevice(device: HomeyDeviceLike): boolean {
  // The driver owns the role. A rejected observation removes only its field,
  // never the battery device's charging identity or its usable sibling fields.
  return teslaDriver(device) === 'battery';
}
