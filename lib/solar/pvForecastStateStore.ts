/**
 * The learned PV-forecast state's rows in the userdata database, behind the
 * port the controller persists through (`PvForecastStore`).
 *
 * The state is up to 90 days of hourly generation buckets with the irradiance
 * recorded beside them, plus the history's sample cursor. Each hour is one row
 * and each cursor field one JSON row, so the five-minute persist writes the hour
 * that changed and the cursor, not the 90 days around them. It used to ride
 * `homey.settings` as one blob behind a written-before marker and a key-list
 * cross-check, because a transient settings miss could read as a fresh install
 * and let the persist overwrite the history. A userdata read answers
 * affirmatively: no rows is absence, and only a throw is a failed read.
 *
 * Rows are validated as read: a bucket's coverage and net evidence are held to
 * what in-memory accrual can produce, so a corrupt row cannot forge training
 * evidence. A row with nothing valid left is the store's own damage,
 * regenerable by ruling, and is dropped (`createJsonRowTable`).
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import {
  hasLegacyImportMark,
  importLegacySettingsKey,
  isLegacySettingsKeyListed,
  legacyImportStanding,
  type LegacyImportResult,
  type LegacyImportStanding,
  type MarkedLegacyImport,
  writeLegacyImportMark,
} from '../store/legacySettingsImport';
import { createJsonRowTable } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import { PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED } from '../utils/settingsKeys';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { PvGenerationHistory, PvHourBucket } from '../../packages/shared-domain/src/solar/pvGenerationHistory';
import { mergeRecoveredPvForecastState, type PvForecastServiceState } from './pvForecastService';
import type { PvForecastStateRead, PvForecastStore } from './pvForecastStore';

const storeLogger = getLogger('solar/pv-forecast-store');

// `isUnknownRecord` rejects arrays, which matters here: an array-shaped
// `hourly` (numeric indices pass the hour-key check) would otherwise read as
// a valid empty state.
const isHourKey = (key: string): boolean => Number.isFinite(Number(key));

// Physical ceiling for an hourly bucket's covered/evidence durations. In-memory
// accrual clamps every segment to the hour boundary (`pvGenerationHistory`), so a
// stored `coveredMs` above this is corrupt — bounding it here stops an oversized
// value (and the net/import sub-durations it would otherwise admit) from forging
// `unclamped` net-evidence that trains the PV gain.
const ONE_HOUR_MS = 60 * 60 * 1000;

// Net-evidence durations are valid only when finite, non-negative, and within
// their accrual bound. A junk field is OMITTED (the hour then classifies
// 'unknown') rather than dropping the whole hour — evidence degrades, energy stays.
const isEvidenceMs = (value: unknown, maxMs: number): value is number => (
  isFiniteNumber(value) && value >= 0 && value <= maxMs
);

/** One stored bucket, or nothing when its energy or coverage is not a real one. */
const normalizeBucket = (value: unknown): PvHourBucket | undefined => {
  if (!isUnknownRecord(value) || !isFiniteNumber(value.kwh) || !isEvidenceMs(value.coveredMs, ONE_HOUR_MS)) {
    return undefined;
  }
  // netMs is bounded by coveredMs; importMs/exportMs are SUB-durations of the
  // net-covered time — in-memory accrual can never produce more, so a row
  // claiming otherwise (e.g. importMs == coveredMs with netMs below it, which
  // would classify a corrupt hour 'unclamped') drops the offending field. With
  // netMs itself invalid the sub-duration bound collapses to 0.
  const netMs = isEvidenceMs(value.netMs, value.coveredMs) ? value.netMs : undefined;
  const subDurationBoundMs = Math.min(netMs ?? 0, value.coveredMs);
  return {
    kwh: value.kwh,
    coveredMs: value.coveredMs,
    ...(netMs === undefined ? {} : { netMs }),
    ...(isEvidenceMs(value.importMs, subDurationBoundMs) ? { importMs: value.importMs } : {}),
    ...(isEvidenceMs(value.exportMs, subDurationBoundMs) ? { exportMs: value.exportMs } : {}),
  };
};

const normalizeHourly = (raw: unknown): Record<string, PvHourBucket> => {
  if (!isUnknownRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    const bucket = isHourKey(key) ? normalizeBucket(value) : undefined;
    return bucket === undefined ? [] : [[key, bucket] as const];
  }));
};

const normalizeNumberMap = (raw: unknown): Record<string, number> => {
  if (!isUnknownRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => (
    isHourKey(key) && isFiniteNumber(value) ? [[key, value] as const] : []
  )));
};

const normalizeTainted = (raw: unknown): Record<string, true> => {
  if (!isUnknownRecord(raw)) return {};
  return Object.fromEntries(Object.keys(raw).flatMap((key) => (isHourKey(key) ? [[key, true] as const] : [])));
};

/**
 * The legacy settings blob, validated field by field, or `null` when it cannot
 * vouch for the history it claims: wrong top-level shape, a missing `hourly`
 * record (every writer produced one, even for the empty state), or claimed
 * hours that ALL failed validation (partial corruption, not emptiness).
 */
export const normalizeLegacyPvForecastState = (raw: unknown): PvForecastServiceState | null => {
  if (!isUnknownRecord(raw) || !isUnknownRecord(raw.history) || !isUnknownRecord(raw.history.hourly)) return null;
  const historyRaw = raw.history;
  const hourly = normalizeHourly(historyRaw.hourly);
  if (Object.keys(historyRaw.hourly as Record<string, unknown>).length > 0 && Object.keys(hourly).length === 0) {
    return null;
  }
  const history: PvGenerationHistory = {
    hourly,
    ...(isFiniteNumber(historyRaw.lastSampleMs) ? { lastSampleMs: historyRaw.lastSampleMs } : {}),
    ...(isFiniteNumber(historyRaw.lastGenerationW) ? { lastGenerationW: historyRaw.lastGenerationW } : {}),
    // SIGNED net anchor — never floor at 0 (export is negative by design).
    ...(isFiniteNumber(historyRaw.lastNetW) ? { lastNetW: historyRaw.lastNetW } : {}),
    ...(isUnknownRecord(historyRaw.taintedHourStarts)
      ? { taintedHourStarts: normalizeTainted(historyRaw.taintedHourStarts) }
      : {}),
  };
  return { history, irradianceByHour: normalizeNumberMap(raw.irradianceByHour) };
};

/** One hour's row: its generation bucket, the irradiance recorded for it, and its gap taint. */
type PvHourRow = { bucket?: PvHourBucket; irradianceWm2?: number; tainted?: true };

/** The history's sample cursor, one row per field. */
const CURSOR_FIELDS = ['lastSampleMs', 'lastGenerationW', 'lastNetW'] as const;
const isCursorField = (key: string): boolean => (CURSOR_FIELDS as readonly string[]).includes(key);

const acceptHourRow = (value: unknown, key: string): PvHourRow | undefined => {
  if (!isHourKey(key) || !isUnknownRecord(value)) return undefined;
  const bucket = normalizeBucket(value.bucket);
  const row: PvHourRow = {
    ...(bucket === undefined ? {} : { bucket }),
    ...(isFiniteNumber(value.irradianceWm2) ? { irradianceWm2: value.irradianceWm2 } : {}),
    ...(value.tainted === true ? { tainted: true as const } : {}),
  };
  return Object.keys(row).length === 0 ? undefined : row;
};

const toHourRows = (state: PvForecastServiceState): Map<string, PvHourRow> => {
  const { hourly, taintedHourStarts = {} } = state.history;
  const keys = new Set([
    ...Object.keys(hourly), ...Object.keys(state.irradianceByHour), ...Object.keys(taintedHourStarts),
  ]);
  return new Map([...keys].map((key) => {
    const bucket = hourly[key];
    const irradianceWm2 = state.irradianceByHour[key];
    return [key, {
      ...(bucket === undefined ? {} : { bucket }),
      ...(irradianceWm2 === undefined ? {} : { irradianceWm2 }),
      ...(taintedHourStarts[key] === true ? { tainted: true as const } : {}),
    }];
  }));
};

const fromRows = (
  hours: ReadonlyMap<string, PvHourRow>,
  cursor: ReadonlyMap<string, number>,
): PvForecastServiceState => {
  const rows = [...hours];
  const taintedHourStarts = Object.fromEntries(rows.flatMap(([key, row]) => (
    row.tainted === true ? [[key, true] as const] : []
  )));
  return {
    history: {
      hourly: Object.fromEntries(rows.flatMap(([key, row]) => (
        row.bucket === undefined ? [] : [[key, row.bucket] as const]
      ))),
      ...Object.fromEntries(CURSOR_FIELDS.flatMap((field) => {
        const value = cursor.get(field);
        return value === undefined ? [] : [[field, value] as const];
      })),
      ...(Object.keys(taintedHourStarts).length === 0 ? {} : { taintedHourStarts }),
    },
    irradianceByHour: Object.fromEntries(rows.flatMap(([key, row]) => (
      row.irradianceWm2 === undefined ? [] : [[key, row.irradianceWm2] as const]
    ))),
  };
};

/** The store as this module builds it: the controller's port, and the legacy import's. */
export type PvForecastRepository = PvForecastStore & MarkedLegacyImport<PvForecastServiceState>;

export const createPvForecastStateStore = (db: UserdataDatabase): PvForecastRepository => {
  const hours = createJsonRowTable(db, 'pv_forecast_hours', ['hour_start', 'row_json'], acceptHourRow);
  const cursor = createJsonRowTable<number>(
    db, 'pv_forecast_cursor', ['field', 'value_json'],
    (value, key) => (isCursorField(key) && isFiniteNumber(value) ? value : undefined),
  );
  const readState = (): PvForecastStateRead => {
    const storedHours = hours.read();
    const storedCursor = cursor.read();
    if (storedHours.size === 0 && storedCursor.size === 0) return { kind: 'absent' };
    return { kind: 'loaded', state: fromRows(storedHours, storedCursor) };
  };
  const writeRows = (state: PvForecastServiceState): void => {
    hours.write(toHourRows(state));
    cursor.write(new Map(CURSOR_FIELDS.flatMap((field) => {
      const value = state.history[field];
      return value === undefined ? [] : [[field, value] as const];
    })));
  };
  return {
    read: () => {
      try {
        return db.transaction(readState);
      } catch {
        return { kind: 'unreadable' };
      }
    },
    write: (state) => db.transaction(() => writeRows(state)),
    hasImportedLegacy: () => hasLegacyImportMark(db, PV_FORECAST_STATE),
    writeLegacyImport: (state) => db.transaction(() => {
      writeRows(state);
      writeLegacyImportMark(db, PV_FORECAST_STATE);
    }),
  };
};

const logImportResult = (result: LegacyImportResult): void => {
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_pv_forecast_state_imported' });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_pv_forecast_state_key_retired', reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_pv_forecast_state_import_deferred',
      reason: result.reason,
      ...(result.error === undefined ? {} : { err: normalizeError(result.error) }),
    });
  }
};

/**
 * Whether the blob is still owed to the store: `pending` when a later attempt
 * may yet import it, `settled` once it is imported, retired, or nothing shows
 * it exists. A key list that cannot be read concludes nothing on its own, so
 * the blob's own read decides: a blob that answers is imported, and one that
 * answers empty settles, since a fresh install answers that way too and the
 * next boot's import merges a blob this one missed.
 */
const importLegacyBlob = (settings: SettingsPort, store: PvForecastRepository): LegacyImportStanding => {
  const listed = isLegacySettingsKeyListed(settings, PV_FORECAST_STATE);
  if (listed === false) return 'settled';
  if (listed === null) {
    let raw: unknown;
    try {
      raw = settings.get(PV_FORECAST_STATE);
    } catch (error) {
      storeLogger.warn({
        event: 'legacy_pv_forecast_state_import_deferred', reason: 'read_threw', err: normalizeError(error),
      });
      return 'pending';
    }
    if (raw === undefined || raw === null) {
      storeLogger.warn({ event: 'legacy_pv_forecast_state_import_deferred', reason: 'key_list_unreadable' });
      return 'settled';
    }
  }
  const result = importLegacySettingsKey(settings, PV_FORECAST_STATE, {
    holds: () => store.hasImportedLegacy(),
    adopt: (raw) => {
      const legacy = normalizeLegacyPvForecastState(raw);
      if (legacy === null) return false;
      const stored = store.read();
      if (stored.kind === 'unreadable') throw new Error('PV forecast store unreadable');
      store.writeLegacyImport(
        stored.kind === 'loaded' ? mergeRecoveredPvForecastState(legacy, stored.state) : legacy,
      );
      return true;
    },
  });
  logImportResult(result);
  return legacyImportStanding(result);
};

/**
 * The one-shot import of the legacy `pv_forecast_state` blob. Rules and their
 * reasons: `lib/store/legacySettingsImport.ts`. The blob goes UNDER whatever
 * the store holds, with the store's hours and cursor winning where the two
 * overlap (the controller's own recovery merge, the store as its live side).
 * Only the import's own mark retires the key. The written-before marker only
 * ever spoke for the blob, so it goes once the blob has.
 */
export const importLegacyPvForecastState = (
  settings: SettingsPort,
  store: PvForecastRepository,
): LegacyImportStanding => {
  const blob = importLegacyBlob(settings, store);
  if (blob === 'settled'
    && isLegacySettingsKeyListed(settings, PV_FORECAST_STATE_INITIALIZED) === true
    && isLegacySettingsKeyListed(settings, PV_FORECAST_STATE) === false) {
    try {
      settings.unset(PV_FORECAST_STATE_INITIALIZED);
    } catch {
      /* retried next boot */
    }
  }
  return blob;
};

/**
 * The store the controller persists through, with the legacy import run
 * first. While the blob is still owed to the store (one missed read on the
 * upgrade boot), every read retries the import and answers `unreadable` until
 * it settles, so the controller defers its writes and merges the imported
 * history under its live state on the next persist tick, rather than trusting
 * an empty store for the whole uptime.
 */
export const createImportingPvForecastStore = (
  settings: SettingsPort,
  repository: PvForecastRepository,
): PvForecastStore => {
  let pending = importLegacyPvForecastState(settings, repository) === 'pending';
  return {
    read: () => {
      if (pending) pending = importLegacyPvForecastState(settings, repository) === 'pending';
      return pending ? { kind: 'unreadable' } : repository.read();
    },
    write: (state) => repository.write(state),
  };
};
