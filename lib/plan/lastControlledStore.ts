/**
 * When PELS last wrote each device, per home, in the userdata database: the
 * repository behind `ActuationRecord.lastDeviceControlledMs`, the one store the
 * app's homes hydrate from and write through, and the one-shot import of the
 * legacy `device_last_controlled_ms` settings keys, retried during the run
 * while a home's key is still owed.
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
  importListedLegacySettingsKey,
  legacyImportStanding,
  type LegacyImportStanding,
  type ListedLegacyImportResult,
  scheduleLegacyImportRetry,
  writeLegacyImportMark,
} from '../store/legacySettingsImport';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { isNumberMap } from '../utils/appTypeGuards';
import { normalizeError } from '../utils/errorUtils';
import { DEVICE_LAST_CONTROLLED_MS, homeScopedSettingsKey, type HomeId } from '../utils/settingsKeys';
import type { TimerRegistry } from '../utils/timerRegistry';
import type { ActuationRecord } from './actuationRecord';

const moduleLogger = getLogger('plan/last-controlled-store');

/** Registry name for the owed legacy imports' retry, one for every home. */
const LEGACY_IMPORT_RETRY_TIMER = 'lastControlledLegacyImportRetry';

export type LastControlledRepository = {
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

export const createLastControlledRepository = (db: UserdataDatabase): LastControlledRepository => {
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

/** Each device's later stamp of the two maps. */
const laterStamps = (
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> => ({
  ...a,
  ...Object.fromEntries(Object.entries(b).map(([deviceId, atMs]) => [deviceId, Math.max(a[deviceId] ?? atMs, atMs)])),
});

/**
 * One attempt at the one-shot import of a home's legacy
 * `device_last_controlled_ms` key (the bare key for the main home,
 * `:<homeId>` for a meter area). Rules and their reasons:
 * `lib/store/legacySettingsImport.ts`. The import mark retires the key, so an
 * unset that failed never imports it twice; the blob merges under what the
 * store holds, keeping the later stamp per device. A value that is not a map of
 * finite numbers holds nothing usable and keeps its key. `onImported` is handed
 * the map the import wrote, the moment it is written.
 */
const importLegacyLastControlled = (
  settings: SettingsPort,
  repository: LastControlledRepository,
  homeId: HomeId,
  onImported: (lastControlledMs: Readonly<Record<string, number>>) => void,
): ListedLegacyImportResult => importListedLegacySettingsKey(settings, legacyKey(homeId), {
  holds: () => repository.hasImportedLegacy(homeId),
  adopt: (raw) => {
    if (!isNumberMap(raw)) return false;
    const imported = Object.fromEntries(Object.entries(raw).filter(([, atMs]) => Number.isFinite(atMs)));
    const merged = laterStamps(repository.read(homeId), imported);
    repository.writeLegacyImport(homeId, merged);
    onImported(merged);
    return true;
  },
});

/**
 * Say what a home's attempt did. A deferral is said only when it differs from
 * `said`, the home's deferral said last, so a key that stays owed is not
 * repeated on every retry; answers the deferral standing after this attempt.
 */
const sayAttempt = (
  homeId: HomeId,
  attempt: ListedLegacyImportResult,
  said: string | undefined,
): string | undefined => {
  if (attempt.outcome === 'not_listed') return undefined;
  if (attempt.outcome === 'imported') {
    moduleLogger.info({ event: 'legacy_last_controlled_imported', homeId });
    return undefined;
  }
  if (attempt.outcome === 'retired') {
    moduleLogger.info({ event: 'legacy_last_controlled_key_retired', homeId, reason: attempt.reason });
    return undefined;
  }
  if (attempt.reason === said) return said;
  moduleLogger.warn({
    event: 'legacy_last_controlled_import_deferred',
    homeId,
    reason: attempt.reason,
    ...('error' in attempt && attempt.error !== undefined ? { err: normalizeError(attempt.error) } : {}),
  });
  return attempt.reason;
};

/**
 * The one last-controlled store every home of the app hydrates from and writes
 * through, keyed by home id.
 */
export type LastControlledStore = {
  /**
   * Import `homeId`'s legacy key, then hand `actuation` what the store holds
   * for the home. While the import is still owed (one missed read on the
   * upgrade boot: a key list that cannot be read, a throwing SDK, a listed key
   * reading empty, a store that cannot be written) it is retried once a minute,
   * and the stamps it brings are merged into `actuation` in the same call that
   * writes them, before the home's next write could delete them: a write makes
   * the store hold exactly the record's map. Throws only on I/O (the read).
   */
  hydrate(homeId: HomeId, actuation: ActuationRecord): void;
  /** Make the store hold exactly `lastControlledMs` for this home, touching only the devices that differ. */
  write(homeId: HomeId, lastControlledMs: Readonly<Record<string, number>>): void;
};

export const createLastControlledStore = (
  settings: SettingsPort,
  repository: LastControlledRepository,
  timers: TimerRegistry,
): LastControlledStore => {
  /** The homes whose legacy key is still owed, each with the record its import goes into. */
  const owed = new Map<HomeId, ActuationRecord>();
  const saidDeferrals = new Map<HomeId, string>();

  const attempt = (homeId: HomeId, actuation: ActuationRecord): LegacyImportStanding => {
    const result = importLegacyLastControlled(settings, repository, homeId, (imported) => {
      actuation.loadLastControlled(laterStamps(actuation.lastDeviceControlledMs, imported));
    });
    const said = sayAttempt(homeId, result, saidDeferrals.get(homeId));
    if (said === undefined) saidDeferrals.delete(homeId);
    else saidDeferrals.set(homeId, said);
    return legacyImportStanding(result);
  };

  const retryOwed = (): void => {
    for (const [homeId, actuation] of owed) {
      if (attempt(homeId, actuation) === 'settled') owed.delete(homeId);
    }
    if (owed.size > 0) scheduleLegacyImportRetry(timers, LEGACY_IMPORT_RETRY_TIMER, retryOwed);
  };

  return {
    hydrate: (homeId, actuation) => {
      // A home built again (a meter area re-created) owes its import to the new record.
      owed.delete(homeId);
      const standing = attempt(homeId, actuation);
      actuation.loadLastControlled(repository.read(homeId));
      if (standing === 'settled') return;
      owed.set(homeId, actuation);
      scheduleLegacyImportRetry(timers, LEGACY_IMPORT_RETRY_TIMER, retryOwed);
    },
    write: (homeId, lastControlledMs) => repository.write(homeId, lastControlledMs),
  };
};
