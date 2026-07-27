import { resolveExplicitMainMeterDeviceId } from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../lib/utils/settingsKeys';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';

type MainMeterSettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
};

/**
 * Classify Main's optional explicit meter without converting a transient SDK
 * miss into Automatic. `undefined` is a trustworthy absence only when the
 * live key list also says the setting does not exist; an explicitly stored
 * `null` remains the normal Automatic selection. All SDK provenance is
 * consumed here: callers receive only `resolved` or semantic `unavailable`.
 */
export const readMainMeterSelection = (
  settings: MainMeterSettingsPort,
): MainMeterSelection => {
  try {
    const raw = settings.get(HOMEY_ENERGY_METER_DEVICE_ID);
    if (raw === null) return { state: 'resolved', meterDeviceId: null };
    if (raw === undefined) {
      const keys = settings.getKeys();
      return keys.length === 0 || keys.includes(HOMEY_ENERGY_METER_DEVICE_ID)
        ? { state: 'unavailable' }
        : { state: 'resolved', meterDeviceId: null };
    }
    if (typeof raw !== 'string') {
      return { state: 'unavailable' };
    }
    const meterDeviceId = resolveExplicitMainMeterDeviceId(raw);
    return meterDeviceId === null
      ? { state: 'unavailable' }
      : { state: 'resolved', meterDeviceId };
  } catch {
    return { state: 'unavailable' };
  }
};
