import type { HomeyDeviceLike } from '../../utils/types';

const FUTUREHOME_CHARGER_DRIVER_ID = 'homey:app:no.futurehome:ev_charger';
const CURRENT_LIMIT_SETTING = 'currentLimit';

export function isFuturehomeCharger(device: HomeyDeviceLike): boolean {
  return device.driverId === FUTUREHOME_CHARGER_DRIVER_ID;
}

/** The current limit Homey last sent, or no reading when the setting holds a value outside 6-32 A. */
export function readCurrentLimit(device: HomeyDeviceLike): number | undefined {
  const value = device.settings?.[CURRENT_LIMIT_SETTING];
  return typeof value === 'number' && Number.isInteger(value) && value >= 6 && value <= 32 ? value : undefined;
}
