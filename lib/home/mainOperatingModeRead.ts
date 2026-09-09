import type { SettingsPort } from '../ports/homeyRuntime';
import { MAIN_HOME_ID, OPERATING_MODE_SETTING } from '../utils/settingsKeys';
import type { DeviceModeForTemperatureUpdate } from './observedTemperatureModeUpdates';

/** Resolve the external Main mode name (including retained rename aliases)
 * before any consumer uses it as a persistent catalog key. */
export function readMainOperatingMode(
  settings: SettingsPort,
  resolveModeName: (mode: string) => string,
): DeviceModeForTemperatureUpdate {
  try {
    const raw = settings.get(OPERATING_MODE_SETTING);
    if (raw === null || raw === undefined) {
      const keys = settings.getKeys();
      if (Array.isArray(keys) && keys.length > 0
        && keys.every((key) => typeof key === 'string') && !keys.includes(OPERATING_MODE_SETTING)) {
        return { state: 'resolved', mode: null, homeId: MAIN_HOME_ID, catalogHomeId: MAIN_HOME_ID };
      }
    }
    if (typeof raw !== 'string' || !raw.trim()) return { state: 'unavailable' };
    return {
      state: 'resolved', mode: resolveModeName(raw), homeId: MAIN_HOME_ID, catalogHomeId: MAIN_HOME_ID,
    };
  } catch {
    return { state: 'unavailable' };
  }
}
