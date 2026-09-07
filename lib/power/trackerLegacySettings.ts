/**
 * The tracker used to persist as one JSON blob under `homey.settings`
 * (`power_tracker_state` for the Main home, `power_tracker_state:<homeId>`
 * for a meter area). It persists to the userdata store now, and an install
 * that upgrades still carries the blob: this module imports it once, at boot,
 * and retires the key — the history behind the budget pace, the Usage panel,
 * the learned hourly averages and the learned smart-task profiles all ride in
 * it, and a user upgrading should keep every one of them.
 *
 * Import rules, per home:
 * - the store already holds rows → the blob is stale, the key is unset;
 * - the store is empty and the blob salvages to a plausible tracker → written
 *   whole, then the key is unset. The previous release wrote the blob under a
 *   looser guard, so it is read at the finest grain: a bad entry is dropped
 *   (logged), never the history around it;
 * - the read is suspect (a listed key answering empty or a value with no
 *   tracker in it, a throwing SDK, a store that cannot be read or written) →
 *   nothing is touched, and the next boot tries again. A listed key reading
 *   back malformed is a failed read, not an affirmative absence
 *   (`notes/persisted-settings-state.md`); one transient must never cost the
 *   history, and a blob that is truly garbage costs its bytes, never the key.
 *
 * Delete this module once no install older than the release that introduced
 * the store can still be upgraded.
 */
import { getLogger } from '../logging/logger';
import { salvagePowerTrackerState } from '../utils/appTypeGuards';
import { normalizeError } from '../utils/errorUtils';
import { MAIN_HOME_ID, POWER_TRACKER_STATE, type HomeId } from '../utils/settingsKeys';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { TrackerStore } from './trackerStore';

const importLogger = getLogger('power/tracker-legacy-import');

/** What one boot did with the legacy blobs, by home. */
export type LegacyTrackerImport = {
  imported: HomeId[];
  /** Keys unset without an import: the store already held the home. */
  retired: HomeId[];
  /**
   * Left in place for the next boot: a suspect read (a value with no tracker
   * in it included), or a store that could not answer.
   */
  deferred: HomeId[];
};

const legacyHomeId = (key: string): HomeId | null => {
  if (key === POWER_TRACKER_STATE) return MAIN_HOME_ID;
  const prefix = `${POWER_TRACKER_STATE}:`;
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null;
};

type Outcome = 'imported' | 'retired' | 'deferred';

const importOne = (
  settings: SettingsPort,
  store: TrackerStore,
  key: string,
  homeId: HomeId,
): Outcome => {
  let raw: unknown;
  try {
    raw = settings.get(key);
  } catch (error) {
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred', homeId,
      reason: 'read_threw',
      err: normalizeError(error),
    });
    return 'deferred';
  }
  if (raw === undefined || raw === null) {
    // A listed key that answers empty is the SDK omission the abandon-grace
    // rule names: not evidence of anything, and never a reason to unset.
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred', homeId,
      reason: 'listed_key_empty',
    });
    return 'deferred';
  }
  let existing;
  try {
    existing = store.load(homeId);
  } catch (error) {
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred', homeId,
      reason: 'store_unreadable',
      err: normalizeError(error),
    });
    return 'deferred';
  }
  if (existing !== null) {
    settings.unset(key);
    importLogger.info({
      event: 'legacy_power_tracker_key_retired', homeId,
      reason: 'store_already_holds_home',
    });
    return 'retired';
  }
  return importFresh(settings, store, key, homeId, raw);
};

/** The store holds nothing for the home: write what the blob salvages to, then retire the key. */
const importFresh = (
  settings: SettingsPort,
  store: TrackerStore,
  key: string,
  homeId: HomeId,
  raw: unknown,
): Outcome => {
  const salvaged = salvagePowerTrackerState(raw);
  if (salvaged === null) {
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred', homeId,
      reason: 'blob_not_a_tracker',
    });
    return 'deferred';
  }
  try {
    store.replace(homeId, salvaged.state);
  } catch (error) {
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred', homeId,
      reason: 'store_write_failed',
      err: normalizeError(error),
    });
    return 'deferred';
  }
  settings.unset(key);
  if (salvaged.dropped.length > 0) {
    importLogger.error({ event: 'legacy_power_tracker_import_salvaged', homeId, dropped: salvaged.dropped });
  }
  importLogger.info({
    event: 'legacy_power_tracker_imported', homeId,
    buckets: Object.keys(salvaged.state.buckets ?? {}).length,
  });
  return 'imported';
};

/**
 * Import every legacy tracker blob the settings still carry into the store,
 * retiring each key as it goes. Best-effort at the SDK: a throwing `unset`
 * leaves a key the next boot retires again, and nothing reads it meanwhile.
 */
export const importLegacyPowerTrackers = (
  settings: SettingsPort,
  store: TrackerStore,
): LegacyTrackerImport => {
  const result: LegacyTrackerImport = { imported: [], retired: [], deferred: [] };
  let keys: string[];
  try {
    keys = settings.getKeys();
  } catch (error) {
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred',
      reason: 'key_list_threw',
      err: normalizeError(error),
    });
    return result;
  }
  for (const key of keys) {
    const homeId = legacyHomeId(key);
    if (homeId === null) continue;
    let outcome: Outcome;
    try {
      outcome = importOne(settings, store, key, homeId);
    } catch (error) {
      // The unset itself threw: the store may hold the home now, and the next
      // boot finds it there and retires the key.
      importLogger.warn({
        event: 'legacy_power_tracker_import_deferred', homeId,
        reason: 'unset_threw',
        err: normalizeError(error),
      });
      outcome = 'deferred';
    }
    result[outcome].push(homeId);
  }
  return result;
};
