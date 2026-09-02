import { resolveExplicitMainMeterDeviceId } from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../lib/utils/settingsKeys';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';

type MainMeterSettingsPort = {
  get(key: string): unknown;
};

/**
 * Classify Main's explicit meter. Absence is never a value any more (the
 * stored-null Automatic selection is retired and the save seam cannot write
 * it), so every non-string read — `null`, `undefined`, junk — is honestly
 * `unavailable`: a transient SDK miss, a malformed value, or a legacy
 * Automatic install whose owner has not picked a meter yet (the boot-time
 * sole-meter adoption fills it when Homey Energy lists exactly one whole-home
 * meter; otherwise the no-readings banner names the remedy). The
 * old `getKeys()` cross-check existed only to tell a transient miss apart
 * from never-written-means-Automatic; with that meaning gone, so is the
 * cross-check. All SDK provenance is consumed here: callers receive only
 * `resolved` or semantic `unavailable`.
 */
export const readMainMeterSelection = (
  settings: MainMeterSettingsPort,
): MainMeterSelection => {
  try {
    const raw = settings.get(HOMEY_ENERGY_METER_DEVICE_ID);
    if (typeof raw !== 'string') return { state: 'unavailable' };
    const meterDeviceId = resolveExplicitMainMeterDeviceId(raw);
    return meterDeviceId === null
      ? { state: 'unavailable' }
      : { state: 'resolved', meterDeviceId };
  } catch {
    return { state: 'unavailable' };
  }
};
