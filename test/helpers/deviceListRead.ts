import type { DeviceListRead } from '../../lib/device/deviceListRead';
import type { HomeyDeviceLike } from '../../lib/utils/types';

/** A fetched list whose every read conformed to the device-read contract. */
export const conformingRead = (devices: HomeyDeviceLike[]): DeviceListRead => ({
  devices,
  ignoredIds: new Set(),
});
