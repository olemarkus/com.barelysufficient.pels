/**
 * The tracker used to persist as one JSON blob under `homey.settings`
 * (`power_tracker_state` for the Main home, `power_tracker_state:<homeId>`
 * for a meter area). It persists to the userdata store now, and an install
 * that upgrades still carries the blob: this module imports it once, at boot,
 * and retires the key — the history behind the budget pace, the Usage panel,
 * the learned hourly averages and the learned smart-task profiles all ride in
 * it, and a user upgrading should keep every one of them.
 *
 * The rules — suspect read, unusable value — are the store's
 * (`lib/store/legacySettingsImport.ts`). What is the tracker's: the previous
 * release wrote the blob under a looser guard than the store applies, so it
 * is read at the finest grain (`salvagePowerTrackerState`): a bad entry is
 * dropped and named, never the history around it. And the blob goes UNDER
 * whatever the store already holds: a boot whose import deferred still
 * hydrates an empty tracker and persists it at the first prune, and the next
 * boot's import must keep both — the history from the blob, the hours since
 * from the store.
 *
 * Delete this module once no install older than the release that introduced
 * the store can still be upgraded.
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import {
  importLegacySettingsKey, listLegacySettingsKeys, type LegacyImportResult,
} from '../store/legacySettingsImport';
import { salvagePowerTrackerState } from '../utils/appTypeGuards';
import { normalizeError } from '../utils/errorUtils';
import { MAIN_HOME_ID, POWER_TRACKER_STATE, type HomeId } from '../utils/settingsKeys';
import { withHistoryUnder } from './homeTrackerPersistence';
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

/** Import one home's blob; `dropped` names what the salvage left out of an import. */
const importHome = (
  settings: SettingsPort,
  store: TrackerStore,
  key: string,
  homeId: HomeId,
): LegacyImportResult['outcome'] => {
  let dropped: readonly string[] = [];
  const outcome = importLegacySettingsKey(settings, key, {
    holds: () => false,
    adopt: (raw) => {
      const salvaged = salvagePowerTrackerState(raw);
      if (salvaged === null) return false;
      const stored = store.load(homeId);
      store.replace(homeId, stored === null ? salvaged.state : withHistoryUnder(stored, salvaged.state));
      dropped = salvaged.dropped;
      return true;
    },
  });
  if (outcome.outcome === 'imported') {
    if (dropped.length > 0) importLogger.error({ event: 'legacy_power_tracker_import_salvaged', homeId, dropped });
    importLogger.info({ event: 'legacy_power_tracker_imported', homeId });
  } else if (outcome.outcome === 'retired') {
    importLogger.info({ event: 'legacy_power_tracker_key_retired', homeId, reason: outcome.reason });
  } else if (outcome.error === undefined) {
    importLogger.warn({ event: 'legacy_power_tracker_import_deferred', homeId, reason: outcome.reason });
  } else {
    importLogger.warn({
      event: 'legacy_power_tracker_import_deferred', homeId, reason: outcome.reason, err: normalizeError(outcome.error),
    });
  }
  return outcome.outcome;
};

/**
 * Import every legacy tracker blob the settings still carry into the store,
 * retiring each key as it goes.
 */
export const importLegacyPowerTrackers = (
  settings: SettingsPort,
  store: TrackerStore,
): LegacyTrackerImport => {
  const result: LegacyTrackerImport = { imported: [], retired: [], deferred: [] };
  const keys = listLegacySettingsKeys(settings, (candidate) => legacyHomeId(candidate) !== null);
  if (keys === null) {
    importLogger.warn({ event: 'legacy_power_tracker_import_deferred', reason: 'key_list_threw' });
    return result;
  }
  for (const key of keys) {
    const homeId = legacyHomeId(key) ?? MAIN_HOME_ID;
    result[importHome(settings, store, key, homeId)].push(homeId);
  }
  return result;
};
