import type { SettingsPort } from '../ports/homeyRuntime';
import { MAIN_HOME_ID, OPERATING_MODE_SETTING } from '../utils/settingsKeys';
import type { DeviceModeForTemperatureUpdate } from './observedTemperatureModeUpdates';

/**
 * Resolve the external Main mode name (including retained rename aliases)
 * before any consumer uses it as a persistent catalog key.
 *
 * `activeMode` is the runtime's own resolved Main mode, passed in rather than
 * re-derived, and it is what a PROVEN-ABSENT key resolves to. The key is written
 * only by an explicit mode change, so a home whose owner has never switched mode
 * does not have it — while the app itself has been running in the default mode
 * since boot (`app.ts` seeds it, `loadCapacitySettings` keeps it). Answering
 * "no mode" for that home was a third answer to a question the runtime had
 * already settled, and it silently disabled every consumer: an owner who chose
 * "Save as current mode target" on a fresh install saw nothing saved, with no
 * log and no UI signal, until the first mode switch wrote the key.
 *
 * This is the same treatment the sub-home path has always given an absent pin
 * (`resolveHomeOperatingMode`: absent → `globalMode`, no fault). Main was the
 * odd one out.
 *
 * A TRANSIENT miss is still `unavailable`, and that distinction is the whole
 * reason for the key-list cross-check: substituting the default mode for a read
 * that merely failed would let a consumer persist under the wrong mode.
 */
export function readMainOperatingMode(
  settings: SettingsPort,
  resolveModeName: (mode: string) => string,
  activeMode: string,
): DeviceModeForTemperatureUpdate {
  try {
    const raw = settings.get(OPERATING_MODE_SETTING);
    if (raw === null || raw === undefined) {
      const keys = settings.getKeys();
      if (Array.isArray(keys) && keys.length > 0
        && keys.every((key) => typeof key === 'string') && !keys.includes(OPERATING_MODE_SETTING)) {
        // Alias-resolved like any other mode name: the default survives a rename
        // of the mode it names, so a home that renamed Home still resolves to the
        // catalog key its targets are stored under.
        return resolvedMainMode(resolveModeName(activeMode));
      }
    }
    if (typeof raw !== 'string' || !raw.trim()) return { state: 'unavailable' };
    return resolvedMainMode(resolveModeName(raw));
  } catch {
    return { state: 'unavailable' };
  }
}

function resolvedMainMode(mode: string): DeviceModeForTemperatureUpdate {
  return {
    state: 'resolved', mode, homeId: MAIN_HOME_ID, catalogHomeId: MAIN_HOME_ID,
  };
}
