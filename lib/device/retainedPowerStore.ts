/**
 * The device transport's last trusted power readings, kept across restarts.
 *
 * The transport already retains a device's last trusted reading between
 * refreshes (`resolveRetainedMeasuredPower` in `managerParseDeviceFields.ts`):
 * a refresh with no newer sample keeps the last one rather than turning it into
 * absence. That retention lived in memory only, so a restart erased it, and two
 * kinds of device lost their reading until the SDK happened to produce a new one:
 *
 * - a device measured only by `meter_power` needs TWO dated meter observations
 *   to resolve a draw, and its meter does not move while it is off — so a device
 *   PELS had switched off before the restart never got a reading, never regained
 *   its power axis, and was never switched back on;
 * - a device supported only by the reading Homey Energy's live report gives it
 *   has none on the fast boot refresh, which skips that report — and with no
 *   previous snapshot either, its support used to rest on nothing at all.
 *
 * So the transport persists what it retains for a `meter_power` device — the
 * last interval-average reading and the meter anchor the next rate is measured
 * from — and seeds both back at construction. A `measure_power` device resolves
 * its reading on the first read after boot and needs nothing kept. A device
 * supported only through the live report keeps its SUPPORT across the restart
 * (its restored reading answers `isDevicePowerCapable`) and regains its power
 * axis at the first full refresh; until then it takes no power logic, which is
 * the no-op a missing reading always gets. This is the SDK
 * boundary carrying its last good value forward across the gap a restart makes,
 * the same no-op a transient read failure gets; nothing downstream learns there
 * was a restart. A restored reading is as trusted as a retained one was: it is
 * the last value the device reported.
 *
 * Ownership: the only module that knows how retained power is laid out on disk,
 * and the only writer of its tables. History and caches live in the userdata
 * database, never in settings (`notes/settings-key-ownership.md` § "Which store").
 * Everything here is regenerable, so a row that does not parse is the store's own
 * damage: it is deleted as read and said once, and never costs the rows around it.
 */
import { getLogger } from '../logging/logger';
import type { PreparedStatement, UserdataDatabase } from '../store/userdataDatabase';
import type { MeterEnergyReading } from './measuredPowerReader';

const storeLogger = getLogger('device/retained-power-store');

/**
 * A row not re-saved for this long belongs to a device the transport has not
 * seen in a month — removed from Homey, or excluded — and is pruned on load
 * rather than restored. A device that is still seen is re-saved at least every
 * `RETAINED_POWER_TOUCH_INTERVAL_MS`, even when its reading has not changed (a
 * thermostat idle at 0 W for months), so it is never pruned while present.
 */
export const RETAINED_POWER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RETAINED_POWER_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A device's last trusted power reading, as the parse retains it. The
 * delivery-interval record (`MeteredPowerReading`) is deliberately not kept: it
 * describes an interval already booked before the restart, and publishing it
 * again after one would book that energy twice.
 */
export type RetainedPowerReading = {
  measuredPowerKw: number;
  observedAtMs: number;
};

export type RetainedPowerState = {
  readings: ReadonlyMap<string, RetainedPowerReading>;
  meterAnchors: ReadonlyMap<string, MeterEnergyReading>;
};

export type RetainedPowerStore = {
  /** What the store holds, rows older than `RETAINED_POWER_MAX_AGE_MS` pruned. Throws only on I/O. */
  load(nowMs: number): RetainedPowerState;
  /**
   * Persist what the devices in `presentIds` retain, touching only the rows that
   * differ from what the store holds (or that are due a re-save). A present
   * device with no reading or no anchor in `state` has its row deleted — it is
   * here and has none. A device NOT present is left alone: one cycle without it
   * is not its removal, and age pruning on load is the only way its row goes.
   */
  save(state: RetainedPowerState, presentIds: ReadonlySet<string>, nowMs: number): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_power_reading (
  device_id TEXT PRIMARY KEY NOT NULL, reading_json TEXT NOT NULL, saved_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS device_meter_anchor (
  device_id TEXT PRIMARY KEY NOT NULL, kwh REAL NOT NULL, observed_at_ms INTEGER NOT NULL,
  saved_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
`;

type Statements = {
  loadReadings: PreparedStatement;
  upsertReading: PreparedStatement;
  removeReading: PreparedStatement;
  pruneReadings: PreparedStatement;
  loadAnchors: PreparedStatement;
  upsertAnchor: PreparedStatement;
  removeAnchor: PreparedStatement;
  pruneAnchors: PreparedStatement;
};

const prepareStatements = (db: UserdataDatabase): Statements => ({
  loadReadings: db.prepare('SELECT device_id, reading_json, saved_at_ms FROM device_power_reading ORDER BY device_id'),
  upsertReading: db.prepare('INSERT INTO device_power_reading (device_id, reading_json, saved_at_ms) VALUES (?, ?, ?) '
    + 'ON CONFLICT (device_id) DO UPDATE SET reading_json = excluded.reading_json, saved_at_ms = excluded.saved_at_ms'),
  removeReading: db.prepare('DELETE FROM device_power_reading WHERE device_id = ?'),
  pruneReadings: db.prepare('DELETE FROM device_power_reading WHERE saved_at_ms < ?'),
  loadAnchors: db.prepare(
    'SELECT device_id, kwh, observed_at_ms, saved_at_ms FROM device_meter_anchor ORDER BY device_id',
  ),
  upsertAnchor: db.prepare('INSERT INTO device_meter_anchor (device_id, kwh, observed_at_ms, saved_at_ms) '
    + 'VALUES (?, ?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET kwh = excluded.kwh, '
    + 'observed_at_ms = excluded.observed_at_ms, saved_at_ms = excluded.saved_at_ms'),
  removeAnchor: db.prepare('DELETE FROM device_meter_anchor WHERE device_id = ?'),
  pruneAnchors: db.prepare('DELETE FROM device_meter_anchor WHERE saved_at_ms < ?'),
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isNonNegativeFinite = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The persisted row re-entering from disk: validated here, trusted inward. */
const parseRetainedPowerReading = (json: string): RetainedPowerReading | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isNonNegativeFinite(raw.measuredPowerKw) || !isFiniteNumber(raw.observedAtMs)) return null;
  return { measuredPowerKw: raw.measuredPowerKw, observedAtMs: raw.observedAtMs };
};

const sameReading = (a: RetainedPowerReading, b: RetainedPowerReading): boolean => (
  JSON.stringify(a) === JSON.stringify(b)
);
const sameAnchor = (a: MeterEnergyReading, b: MeterEnergyReading): boolean => (
  a.kwh === b.kwh && a.observedAtMs === b.observedAtMs
);

type HeldRow<T> = { value: T; savedAtMs: number };

export const createRetainedPowerStore = (db: UserdataDatabase): RetainedPowerStore => {
  db.exec(SCHEMA);
  const s = prepareStatements(db);
  // What the store holds, and when each row was last written: `save` diffs
  // against it, so a refresh that changed one device's reading writes one row.
  const heldReadings = new Map<string, HeldRow<RetainedPowerReading>>();
  const heldAnchors = new Map<string, HeldRow<MeterEnergyReading>>();

  const readRows = (nowMs: number): RetainedPowerState => {
    heldReadings.clear();
    heldAnchors.clear();
    const readings = new Map<string, RetainedPowerReading>();
    for (const row of s.loadReadings.all() as Array<{ device_id: string; reading_json: string; saved_at_ms: number }>) {
      const reading = parseRetainedPowerReading(row.reading_json);
      if (reading === null) {
        storeLogger.error({ event: 'device_power_reading_row_quarantined', deviceId: row.device_id });
        s.removeReading.run(row.device_id);
        continue;
      }
      readings.set(row.device_id, reading);
      heldReadings.set(row.device_id, { value: reading, savedAtMs: savedAtOf(row.saved_at_ms, nowMs) });
    }
    const meterAnchors = new Map<string, MeterEnergyReading>();
    const anchorRows = s.loadAnchors.all() as Array<{
      device_id: string; kwh: unknown; observed_at_ms: unknown; saved_at_ms: number;
    }>;
    for (const row of anchorRows) {
      if (!isNonNegativeFinite(row.kwh) || !isFiniteNumber(row.observed_at_ms)) {
        storeLogger.error({ event: 'device_meter_anchor_row_quarantined', deviceId: row.device_id });
        s.removeAnchor.run(row.device_id);
        continue;
      }
      const anchor = { kwh: row.kwh, observedAtMs: row.observed_at_ms };
      meterAnchors.set(row.device_id, anchor);
      heldAnchors.set(row.device_id, { value: anchor, savedAtMs: savedAtOf(row.saved_at_ms, nowMs) });
    }
    return { readings, meterAnchors };
  };

  const isDue = <T>(held: HeldRow<T> | undefined, next: T, same: (a: T, b: T) => boolean, nowMs: number): boolean => (
    held === undefined
    || !same(held.value, next)
    || nowMs - held.savedAtMs >= RETAINED_POWER_TOUCH_INTERVAL_MS
  );

  return {
    load: (nowMs) => db.transaction(() => {
      const cutoffMs = nowMs - RETAINED_POWER_MAX_AGE_MS;
      s.pruneReadings.run(cutoffMs);
      s.pruneAnchors.run(cutoffMs);
      return readRows(nowMs);
    }),
    save: (state, presentIds, nowMs) => {
      // The held maps change only once the transaction has committed: a rolled
      // back write must not leave them claiming rows the database never got.
      const readingWrites: Array<[string, RetainedPowerReading | null]> = [];
      const anchorWrites: Array<[string, MeterEnergyReading | null]> = [];
      db.transaction(() => {
        for (const deviceId of presentIds) {
          const reading = state.readings.get(deviceId);
          if (reading === undefined) {
            if (heldReadings.has(deviceId)) {
              s.removeReading.run(deviceId);
              readingWrites.push([deviceId, null]);
            }
          } else if (isDue(heldReadings.get(deviceId), reading, sameReading, nowMs)) {
            s.upsertReading.run(deviceId, JSON.stringify(reading), nowMs);
            readingWrites.push([deviceId, reading]);
          }
          const anchor = state.meterAnchors.get(deviceId);
          if (anchor === undefined) {
            if (heldAnchors.has(deviceId)) {
              s.removeAnchor.run(deviceId);
              anchorWrites.push([deviceId, null]);
            }
          } else if (isDue(heldAnchors.get(deviceId), anchor, sameAnchor, nowMs)) {
            s.upsertAnchor.run(deviceId, anchor.kwh, anchor.observedAtMs, nowMs);
            anchorWrites.push([deviceId, anchor]);
          }
        }
      });
      applyWrites(heldReadings, readingWrites, nowMs);
      applyWrites(heldAnchors, anchorWrites, nowMs);
    },
  };
};

const applyWrites = <T>(
  held: Map<string, HeldRow<T>>,
  writes: ReadonlyArray<[string, T | null]>,
  nowMs: number,
): void => {
  for (const [deviceId, value] of writes) {
    if (value === null) held.delete(deviceId);
    else held.set(deviceId, { value, savedAtMs: nowMs });
  }
};

// A stored stamp that is not a finite number cannot be aged; treat the row as
// written now, so it is kept and re-stamped by the next save that sees it.
const savedAtOf = (value: unknown, nowMs: number): number => (isFiniteNumber(value) ? value : nowMs);
