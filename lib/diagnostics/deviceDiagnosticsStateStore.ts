/**
 * The device diagnostics' rows in the userdata database, behind the port the
 * diagnostics service persists through.
 *
 * The state is one day aggregate per (device, local day) over a 21-day
 * window — ten devices' worth was 80 kB riding `homey.settings` as one blob,
 * flushed every five minutes. Each aggregate is one row and the envelope's
 * scalars (`version`, `windowDays`, `generatedAt`) are one row each, diffed
 * against what the store holds so a flush writes the days that changed.
 *
 * The service mutates its state tree in place between flushes, so the diff
 * base is the JSON of each row as last written or read, never an object
 * reference. `read` runs the same version/window sanitisation the settings
 * adapter ran, so the service receives typed state plus repair metadata; a
 * row that does not parse is the store's own damage — regenerable by ruling
 * — and is deleted on read and said once.
 */
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { importLegacySettingsKey, isLegacySettingsKeyListed } from '../store/legacySettingsImport';
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
import { normalizeError } from '../utils/errorUtils';
import {
  type PersistedDayAggregate, type PersistedDiagnosticsState, sanitizePersistedState,
} from './deviceDiagnosticsModel';
import {
  DEVICE_DIAGNOSTICS_PERSIST_VERSION,
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DEVICE_DIAGNOSTICS_WINDOW_DAYS,
} from './deviceDiagnosticsPersistence';

const storeLogger = getLogger('diagnostics/state-store');

/**
 * Result of reading the persisted diagnostics state: the sanitised state plus
 * the repair/reset metadata the service surfaces as a debug event. Mirrors the
 * shape of `sanitizePersistedState`, which the store runs.
 */
export type DeviceDiagnosticsStateRead = {
  state: PersistedDiagnosticsState;
  repaired: boolean;
  resetReason?: string;
};

/**
 * Domain-owned read/write boundary for the persisted device-diagnostics
 * state. The service depends on this type, never on a database or on
 * `homey.settings`; `createDeviceDiagnosticsStateStore` below is its one
 * production implementation.
 */
export type DeviceDiagnosticsStateStore = {
  read(): DeviceDiagnosticsStateRead;
  write(state: PersistedDiagnosticsState): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_diagnostics_days (
  device_id TEXT NOT NULL, date_key TEXT NOT NULL, aggregate_json TEXT NOT NULL,
  PRIMARY KEY (device_id, date_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS device_diagnostics_meta (
  key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL
) WITHOUT ROWID;
`;

type Statements = {
  upsertDay: PreparedStatement; deleteDay: PreparedStatement; loadDays: PreparedStatement;
  upsertMeta: PreparedStatement; deleteMeta: PreparedStatement; loadMeta: PreparedStatement;
};

const prepareStatements = (db: UserdataDatabase): Statements => ({
  upsertDay: db.prepare('INSERT INTO device_diagnostics_days (device_id, date_key, aggregate_json) VALUES (?, ?, ?) '
    + 'ON CONFLICT (device_id, date_key) DO UPDATE SET aggregate_json = excluded.aggregate_json'),
  deleteDay: db.prepare('DELETE FROM device_diagnostics_days WHERE device_id = ? AND date_key = ?'),
  loadDays: db.prepare('SELECT device_id, date_key, aggregate_json FROM device_diagnostics_days'),
  upsertMeta: db.prepare('INSERT INTO device_diagnostics_meta (key, value_json) VALUES (?, ?) '
    + 'ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json'),
  deleteMeta: db.prepare('DELETE FROM device_diagnostics_meta WHERE key = ?'),
  loadMeta: db.prepare('SELECT key, value_json FROM device_diagnostics_meta'),
});

const META_KEYS = [
  'version', 'windowDays', 'generatedAt',
] as const satisfies readonly (keyof PersistedDiagnosticsState)[];

/** The rows as JSON, keyed `device_id date_key` for days and by name for meta: the diff base. */
type Held = { days: Map<string, string>; meta: Map<string, string> };

/** The envelope shape the rows hold — the typed state, or the raw rows before sanitisation. */
type Envelope = { devicesById: Record<string, { daysByDateKey: Record<string, unknown> }> } & Record<string, unknown>;

/** A day's map key: a JSON pair, so a device id with any character in it round-trips. */
const dayKey = (deviceId: string, dateKey: string): string => JSON.stringify([deviceId, dateKey]);
const dayOf = (key: string): [string, string] => JSON.parse(key) as [string, string];

const heldOf = (envelope: Envelope): Held => {
  const days = new Map<string, string>();
  for (const [deviceId, device] of Object.entries(envelope.devicesById)) {
    for (const [dateKey, aggregate] of Object.entries(device.daysByDateKey)) {
      days.set(dayKey(deviceId, dateKey), JSON.stringify(aggregate));
    }
  }
  return { days, meta: new Map(META_KEYS.map((key) => [key, JSON.stringify(envelope[key])])) };
};

const parseRow = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

export const createDeviceDiagnosticsStateStore = (db: UserdataDatabase): DeviceDiagnosticsStateStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);
  let held: Held | null = null;

  /** The raw envelope from the rows, or `null` when the store holds nothing; runs inside a transaction. */
  const loadRaw = (): Envelope | null => {
    const dayRows = s.loadDays.all() as Array<{ device_id: string; date_key: string; aggregate_json: string }>;
    const metaRows = s.loadMeta.all() as Array<{ key: string; value_json: string }>;
    if (dayRows.length === 0 && metaRows.length === 0) return null;
    const parsedDays = dayRows.flatMap((row) => {
      const aggregate = parseRow(row.aggregate_json);
      if (aggregate !== undefined) return [{ deviceId: row.device_id, dateKey: row.date_key, aggregate }];
      storeLogger.error({
        event: 'device_diagnostics_row_quarantined', deviceId: row.device_id, dateKey: row.date_key,
      });
      s.deleteDay.run(row.device_id, row.date_key);
      return [];
    });
    const deviceIds = [...new Set(parsedDays.map((row) => row.deviceId))];
    const devicesById = Object.fromEntries(deviceIds.map((deviceId) => [deviceId, {
      daysByDateKey: Object.fromEntries(parsedDays
        .filter((row) => row.deviceId === deviceId)
        .map((row) => [row.dateKey, row.aggregate])),
    }]));
    const meta = Object.fromEntries(metaRows.flatMap((row) => {
      const value = parseRow(row.value_json);
      if (value !== undefined) return [[row.key, value] as const];
      storeLogger.error({ event: 'device_diagnostics_row_quarantined', key: row.key });
      s.deleteMeta.run(row.key);
      return [];
    }));
    return { ...meta, devicesById };
  };

  const sanitize = (raw: unknown): DeviceDiagnosticsStateRead => sanitizePersistedState({
    raw,
    persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION,
    windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
  });

  const writeDiff = (next: Held, previous: Held | null): void => {
    for (const [key, json] of next.days) {
      if (previous?.days.get(key) === json) continue;
      const [deviceId, dateKey] = dayOf(key);
      s.upsertDay.run(deviceId, dateKey, json);
    }
    for (const key of previous?.days.keys() ?? []) {
      if (next.days.has(key)) continue;
      const [deviceId, dateKey] = dayOf(key);
      s.deleteDay.run(deviceId, dateKey);
    }
    for (const [key, json] of next.meta) {
      if (previous?.meta.get(key) !== json) s.upsertMeta.run(key, json);
    }
  };

  return {
    read: () => db.transaction(() => {
      const raw = loadRaw();
      // The rows as they are on disk are the diff base — not the sanitised
      // state, or a day the window pruned on read would never be deleted.
      held = raw === null ? null : heldOf(raw);
      return sanitize(raw);
    }),
    write: (state) => {
      const next = heldOf(state);
      db.transaction(() => {
        // A store that has neither read nor written diffs against its rows
        // on disk, so a write can always delete what `state` dropped.
        const previous = held ?? (() => {
          const stored = loadRaw();
          return stored === null ? null : heldOf(stored);
        })();
        writeDiff(next, previous);
      });
      held = next;
    },
  };
};

const minOf = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  return b === null ? a : Math.min(a, b);
};
const maxOf = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
};

/**
 * One local day recorded under both the legacy blob and the store: the
 * upgrade day, when the import deferred and the service wrote fresh rows
 * for the rest of it. Every field is a sum, a count or a min/max, so the two
 * periods combine without losing either.
 */
const mergeDayAggregates = (legacy: PersistedDayAggregate, stored: PersistedDayAggregate): PersistedDayAggregate => ({
  unmetDemandMs: legacy.unmetDemandMs + stored.unmetDemandMs,
  blockedByHeadroomMs: legacy.blockedByHeadroomMs + stored.blockedByHeadroomMs,
  blockedByCooldownBackoffMs: legacy.blockedByCooldownBackoffMs + stored.blockedByCooldownBackoffMs,
  targetDeficitMs: legacy.targetDeficitMs + stored.targetDeficitMs,
  shedCount: legacy.shedCount + stored.shedCount,
  restoreCount: legacy.restoreCount + stored.restoreCount,
  failedActivationCount: legacy.failedActivationCount + stored.failedActivationCount,
  stableActivationCount: legacy.stableActivationCount + stored.stableActivationCount,
  shedToRestoreCount: legacy.shedToRestoreCount + stored.shedToRestoreCount,
  shedToRestoreTotalMs: legacy.shedToRestoreTotalMs + stored.shedToRestoreTotalMs,
  restoreToSetbackCount: legacy.restoreToSetbackCount + stored.restoreToSetbackCount,
  restoreToSetbackTotalMs: legacy.restoreToSetbackTotalMs + stored.restoreToSetbackTotalMs,
  restoreToSetbackMinMs: minOf(legacy.restoreToSetbackMinMs, stored.restoreToSetbackMinMs),
  restoreToSetbackMaxMs: maxOf(legacy.restoreToSetbackMaxMs, stored.restoreToSetbackMaxMs),
  penaltyBumpCount: legacy.penaltyBumpCount + stored.penaltyBumpCount,
  penaltyMaxLevelSeen: Math.max(legacy.penaltyMaxLevelSeen, stored.penaltyMaxLevelSeen),
});

/**
 * The legacy blob's days under the store's: a day only the blob has is
 * adopted, a day both have is the two periods combined, and the store's
 * envelope wins — a store that has written an envelope but no device yet
 * keeps its `generatedAt`; only a store that never stamped one takes the
 * blob's.
 */
const withLegacyUnder = (
  stored: PersistedDiagnosticsState,
  legacy: PersistedDiagnosticsState,
): PersistedDiagnosticsState => {
  const deviceIds = [...new Set([...Object.keys(legacy.devicesById), ...Object.keys(stored.devicesById)])];
  const devicesById = Object.fromEntries(deviceIds.map((deviceId) => {
    const legacyDays = legacy.devicesById[deviceId]?.daysByDateKey ?? {};
    const storedDays = stored.devicesById[deviceId]?.daysByDateKey ?? {};
    const dateKeys = [...new Set([...Object.keys(legacyDays), ...Object.keys(storedDays)])];
    return [deviceId, {
      daysByDateKey: Object.fromEntries(dateKeys.flatMap((dateKey): Array<[string, PersistedDayAggregate]> => {
        const fromLegacy = legacyDays[dateKey];
        const fromStore = storedDays[dateKey];
        if (fromLegacy !== undefined && fromStore !== undefined) {
          return [[dateKey, mergeDayAggregates(fromLegacy, fromStore)]];
        }
        const only = fromLegacy ?? fromStore;
        return only === undefined ? [] : [[dateKey, only]];
      })),
    }];
  }));
  return { ...stored, generatedAt: stored.generatedAt ?? legacy.generatedAt, devicesById };
};

/**
 * The one-shot import of the legacy `device_diagnostics_v1` settings blob
 * into the store, run at boot before the service loads. Rules and their
 * reasons: `lib/store/legacySettingsImport.ts`. The blob goes UNDER whatever
 * the store holds, and a blob the sanitiser resets (another version, a
 * malformed envelope) holds nothing usable.
 */
export const importLegacyDeviceDiagnostics = (settings: SettingsPort, store: DeviceDiagnosticsStateStore): void => {
  if (isLegacySettingsKeyListed(settings, DEVICE_DIAGNOSTICS_STATE_KEY) !== true) return;
  const result = importLegacySettingsKey(settings, DEVICE_DIAGNOSTICS_STATE_KEY, {
    holds: () => false,
    adopt: (raw) => {
      const legacy = sanitizePersistedState({
        raw, persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION, windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
      });
      if (legacy.resetReason !== undefined) return false;
      store.write(withLegacyUnder(store.read().state, legacy.state));
      return true;
    },
  });
  if (result.outcome === 'imported') {
    storeLogger.info({ event: 'legacy_device_diagnostics_imported' });
  } else if (result.outcome === 'retired') {
    storeLogger.info({ event: 'legacy_device_diagnostics_key_retired', reason: result.reason });
  } else if (result.error === undefined) {
    storeLogger.warn({ event: 'legacy_device_diagnostics_import_deferred', reason: result.reason });
  } else {
    storeLogger.warn({
      event: 'legacy_device_diagnostics_import_deferred', reason: result.reason, err: normalizeError(result.error),
    });
  }
};
