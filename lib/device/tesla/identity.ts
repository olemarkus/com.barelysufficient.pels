import type { HomeyDeviceLike } from '../../utils/types';

export function isTeslaChargingDevice(device: HomeyDeviceLike): boolean {
  // The driver owns the role. A rejected observation removes only its field,
  // never the battery device's charging identity or its usable sibling fields.
  return device.driverId === 'homey:app:com.tesla.car:battery';
}

