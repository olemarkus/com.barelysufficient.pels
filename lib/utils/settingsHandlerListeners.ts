import type { SettingsHandler } from './settingsHandlers';
import {
  CAPACITY_PRIORITIES,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  MAIN_HOME_ID,
  MODE_ALIASES,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  parseHomeScopedSettingsKey,
} from './settingsKeys';

/** The settings change events the handler listens to (`ManagerSettings` satisfies it). */
type SettingsEventsPort = {
  on(event: 'set' | 'unset', listener: (key: string) => Promise<void>): unknown;
  off(event: 'set' | 'unset', listener: (key: string) => Promise<void>): unknown;
};

const MODE_CATALOG_KEYS: ReadonlySet<string> = new Set([
  OPERATING_MODE_SETTING,
  MODE_ALIASES,
  CAPACITY_PRIORITIES,
  MODE_DEVICE_TARGETS,
  MODE_CATALOG_INITIALIZED,
]);

/**
 * Feed the settings `set` and `unset` events to the handler, and return the
 * detach (which also stops the handler).
 *
 * - A `set` the observer recorded itself (`consumeObservedSettingChange`) is
 *   consumed before the handler sees it; an operating-mode write is announced
 *   (`onOperatingModeHandled`) once the handler has applied it.
 * - An `unset` reaches the handler only for the manual expected-power figures
 *   and for a meter area's own mode-catalog keys: Main's catalog and every
 *   other key keep their last value when unset.
 */
export function attachSettingsHandler(
  settings: SettingsEventsPort,
  handler: SettingsHandler,
  consumeObservedSettingChange: (key: string) => boolean,
  onOperatingModeHandled: () => void,
): () => void {
  const onSet = async (key: string): Promise<void> => {
    if (consumeObservedSettingChange(key)) return;
    await handler(key);
    if (key === OPERATING_MODE_SETTING) onOperatingModeHandled();
  };
  const onUnset = async (key: string): Promise<void> => {
    if (key === DEVICE_EXPECTED_POWER_OVERRIDES) {
      await handler(key);
      return;
    }
    const scoped = parseHomeScopedSettingsKey(key);
    if (scoped.homeId === MAIN_HOME_ID || !MODE_CATALOG_KEYS.has(scoped.baseKey)) return;
    await handler(key);
  };
  settings.on('set', onSet);
  settings.on('unset', onUnset);
  return () => {
    settings.off('set', onSet);
    settings.off('unset', onUnset);
    handler.stop();
  };
}
