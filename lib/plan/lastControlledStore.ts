/**
 * When PELS last wrote each device, per home, in the userdata database: the
 * repository behind `ActuationRecord.lastDeviceControlledMs`, and the one-shot
 * import of the legacy `device_last_controlled_ms` settings keys.
 *
 * Actuation history, so it lives in the userdata store by ruling
 * (`notes/settings-key-ownership.md` § "Which store a key lives in"; owner
 * ruling 2026-10-24): a settings write shipped the whole settings object to
 * Homey about nineteen times an hour, and one transient boot read could land
 * as an empty map that the next shed then persisted over the stored history.
 * A userdata read does not fail that way, and a write costs the rows that
 * changed.
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import {
  hasLegacyImportMark,
  importLegacySettingsKey,
  isLegacySettingsKeyListed,
  writeLegacyImportMark,
} from '../store/legacySettingsImport';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { isNumberMap } from '../utils/appTypeGuards';
import { normalizeError } from '../utils/errorUtils';
import { DEVICE_LAST_CONTROLLED_MS, homeScopedSettingsKey, type HomeId } from '../utils/settingsKeys';

const moduleLogger = getLogger('plan/last-controlled-store');

export type LastControlledStore = {
  /** This home's map, device id to epoch ms; empty when it holds none. Throws only on I/O. */
  read(homeId: HomeId): Record<string, number>;
  /** Make the store hold exactly `lastControlledMs` for this home, touching only the devices that differ. */
  write(homeId: HomeId, lastControlledMs: Readonly<Record<string, number>>): void;
  /** Whether this home's legacy settings key was imported. */
  hasImportedLegacy(homeId: HomeId): boolean;
  /** Write this home's imported map and the import mark, in one transaction. */
  writeLegacyImport(homeId: HomeId, lastControlledMs: Readonly<Record<string, number>>): void;
};

const legacyKey = (homeId: HomeId): string => homeScopedSettingsKey(DEVICE_LAST_CONTROLLED_MS, homeId);

export const createLastControlledStore = (db: UserdataDatabase): LastControlledStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS device_last_controlled (
  home_id TEXT NOT NULL, device_id TEXT NOT NULL, at_ms REAL NOT NULL,
  PRIMARY KEY (home_id, device_id)
) WITHOUT ROWID`);
  const load = db.prepare('SELECT device_id AS deviceId, at_ms AS atMs FROM device_last_controlled WHERE home_id = ?');
  const upsert = db.prepare('INSERT INTO device_last_controlled (home_id, device_id, at_ms) VALUES (?, ?, ?) '
    + 'ON CONFLICT (home_id, device_id) DO UPDATE SET at_ms = excluded.at_ms');
  const remove = db.prepare('DELETE FROM device_last_controlled WHERE home_id = ? AND device_id = ?');
  // What each home's rows last were, as values: the executor hands over the
  // map it keeps mutating, so a reference would always compare equal.
  const bases = new Map<HomeId, Map<string, number>>();

  const readRows = (homeId: HomeId): Map<string, number> => {
    const rows = new Map<string, number>();
    for (const row of load.all(homeId) as Array<{ deviceId: string; atMs: number }>) {
      if (Number.isFinite(row.atMs)) rows.set(row.deviceId, row.atMs);
    }
    return rows;
  };

  const writeRows = (homeId: HomeId, next: Readonly<Record<string, number>>): void => {
    const base = bases.get(homeId) ?? readRows(homeId);
    for (const [deviceId, atMs] of Object.entries(next)) {
      if (base.get(deviceId) !== atMs) upsert.run(homeId, deviceId, atMs);
    }
    for (const deviceId of base.keys()) {
      if (!Object.hasOwn(next, deviceId)) remove.run(homeId, deviceId);
    }
    bases.set(homeId, new Map(Object.entries(next)));
  };

  return {
    read: (homeId) => {
      const rows = readRows(homeId);
      bases.set(homeId, rows);
      return Object.fromEntries(rows);
    },
    write: (homeId, lastControlledMs) => {
      try {
        db.transaction(() => writeRows(homeId, lastControlledMs));
      } catch (error) {
        // The rows on disk are what the database last committed.
        bases.delete(homeId);
        throw error;
      }
    },
    hasImportedLegacy: (homeId) => hasLegacyImportMark(db, legacyKey(homeId)),
    writeLegacyImport: (homeId, lastControlledMs) => db.transaction(() => {
      writeRows(homeId, lastControlledMs);
      writeLegacyImportMark(db, legacyKey(homeId));
    }),
  };
};

/**
 * The write one home's signal writers persist the map through, opening the
 * store at the first write: the main home's writers are built before the
 * userdata database opens. The open store is this writer's own state.
 */
export const createLastControlledWriter = (
  getDatabase: () => UserdataDatabase,
  homeId: HomeId,
): ((lastControlledMs: Readonly<Record<string, number>>) => void) => {
  let store: LastControlledStore | undefined;
  return (lastControlledMs) => {
    store ??= createLastControlledStore(getDatabase());
    store.write(homeId, lastControlledMs);
  };
};

/**
 * The one-shot import of a home's legacy `device_last_controlled_ms` key (the
 * bare key for the main home, `:<homeId>` for a meter area), run when that home's
 * plan runtime is built, before the store is read. Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. The import mark retires the key, so an
 * unset that failed never imports it twice; the blob merges under what the
 * store holds, keeping the later stamp per device. A value that is not a map of
 * finite numbers holds nothing usable and keeps its key.
 */
export const importLegacyLastControlled = (
  settings: SettingsPort,
  store: LastControlledStore,
  homeId: HomeId,
): void => {
  const key = legacyKey(homeId);
  const listed = isLegacySettingsKeyListed(settings, key);
  if (listed === null) {
    // Concludes nothing; the next boot tries again. Said, so a boot that
    // hydrated an empty map leaves a trace.
    moduleLogger.warn({ event: 'legacy_last_controlled_import_deferred', homeId, reason: 'key_list_unreadable' });
    return;
  }
  if (!listed) return;
  const result = importLegacySettingsKey(settings, key, {
    holds: () => store.hasImportedLegacy(homeId),
    adopt: (raw) => {
      if (!isNumberMap(raw)) return false;
      const stored = store.read(homeId);
      const imported = Object.entries(raw)
        .filter(([, atMs]) => Number.isFinite(atMs))
        .map(([deviceId, atMs]) => [deviceId, Math.max(stored[deviceId] ?? atMs, atMs)] as const);
      store.writeLegacyImport(homeId, { ...stored, ...Object.fromEntries(imported) });
      return true;
    },
  });
  if (result.outcome === 'imported') {
    moduleLogger.info({ event: 'legacy_last_controlled_imported', homeId });
  } else if (result.outcome === 'retired') {
    moduleLogger.info({ event: 'legacy_last_controlled_key_retired', homeId, reason: result.reason });
  } else {
    moduleLogger.warn({
      event: 'legacy_last_controlled_import_deferred',
      homeId,
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};
