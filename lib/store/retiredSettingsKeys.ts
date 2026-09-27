/**
 * Settings keys that nothing writes or reads any more, unset at boot.
 *
 * The SDK ships the whole settings object to Homey on every write of any key
 * (`notes/settings-key-ownership.md` § "Which store a key lives in"), so a dead
 * key costs its bytes on every write for as long as it stays. Unlike a key that
 * moves to the store (`legacySettingsImport.ts`), these have nowhere to go: the
 * plan snapshots and the per-device action log stopped persisting to settings,
 * and the rest belong to features since removed. The snapshots and the log alone
 * were 49 kB of a 157 kB production settings object on 2026-09-26. Do not reuse
 * these names.
 *
 * Only keys the settings still list are unset, so every boot after the cleanup
 * writes nothing. A key list that cannot be read, or an unset the SDK rejects,
 * leaves the keys for the next boot: one transient must never fail the boot
 * step this runs in.
 */
import type { SettingsPort } from '../ports/homeyRuntime';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { listLegacySettingsKeys } from './legacySettingsImport';

const logger = getLogger('store/retired-settings-keys');

const RETIRED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'target_devices_snapshot',
  'device_plan_snapshot',
  'device_action_log_by_device',
  'app_heartbeat',
  'learned_thermostat_deadband_c',
  'overview_redesign_enabled',
  'daily_budget_breakdown_enabled',
]);

export const unsetRetiredSettingsKeys = (settings: SettingsPort): void => {
  const keys = listLegacySettingsKeys(settings, (key) => RETIRED_SETTINGS_KEYS.has(key));
  if (keys === null || keys.length === 0) return;
  try {
    for (const key of keys) settings.unset(key);
  } catch (error) {
    logger.warn({ event: 'retired_settings_keys_unset_deferred', keys, err: normalizeError(error) });
    return;
  }
  logger.info({ event: 'retired_settings_keys_unset', keys });
};
