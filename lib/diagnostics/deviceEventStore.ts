/**
 * Device events kept for problem reports, beside the device activity history in
 * the app's SQLite database (`deviceActivityStore.ts`).
 *
 * Activity rows are what a device card showed; these are what PELS observed and
 * decided about a device, such as a car link it waited for and gave up on. They
 * have their own table because the Activity page shows card rows only, and a
 * busy charger's events must not take the per-device room its card rows need.
 *
 * An event about several devices (a charger and a car) is stored once per
 * device under one id, so each device's cap counts it, and a read over several
 * devices returns it once.
 */
import { randomUUID } from 'node:crypto';
import type { SupportReportDeviceEvent, SupportReportValue } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { DeviceJournal, DeviceJournalEvent } from '../ports/deviceJournal';
import { parseJsonRow } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';

export const DEVICE_EVENT_RETENTION_DAYS = 7;
export const DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE = 200;
const DEVICE_EVENT_RETENTION_MS = DEVICE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const logger = getLogger('diagnostics/device-events');

export type DeviceEventStore = DeviceJournal & {
  /** Events about any of `deviceIds` (or every device) at or after `fromMs` and at or before `toMs`, oldest first. */
  read(deviceIds: readonly string[] | 'all', fromMs: number, toMs: number): SupportReportDeviceEvent[];
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_event_history (
  id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (device_id, id)
);
CREATE INDEX IF NOT EXISTS device_event_history_device_time ON device_event_history(device_id, at_ms);
CREATE INDEX IF NOT EXISTS device_event_history_age ON device_event_history(at_ms);
CREATE INDEX IF NOT EXISTS device_event_history_id ON device_event_history(id);
`;

const isReportValue = (value: unknown): value is SupportReportValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isReportValue);
  return isUnknownRecord(value) && Object.values(value).every(isReportValue);
};

/** A stored row's event: a JSON object with an event name; anything else is the store's own damage. */
const parseStoredEvent = (json: unknown): { event: string; details: { [key: string]: SupportReportValue } } | null => {
  const parsed = typeof json === 'string' ? parseJsonRow(json) : undefined;
  if (!isUnknownRecord(parsed) || typeof parsed.event !== 'string' || !isReportValue(parsed)) return null;
  const { event, component: _component, ...details } = parsed;
  return { event, details };
};

export const createDeviceEventStore = (db: UserdataDatabase): DeviceEventStore => {
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO device_event_history '
    + '(id, device_id, at_ms, event_json) VALUES (?, ?, ?, ?)');
  const expire = db.prepare('DELETE FROM device_event_history WHERE at_ms < ?');
  const capDevice = db.prepare('DELETE FROM device_event_history WHERE device_id = ? AND id IN ('
    + 'SELECT id FROM device_event_history WHERE device_id = ? ORDER BY at_ms DESC, id DESC LIMIT -1 OFFSET ?)');
  const load = db.prepare('SELECT rowid, id, device_id, at_ms, event_json FROM device_event_history '
    + 'WHERE device_id = ? AND at_ms >= ? AND at_ms <= ?');
  const loadAll = db.prepare('SELECT rowid, id, device_id, at_ms, event_json FROM device_event_history '
    + 'WHERE at_ms >= ? AND at_ms <= ?');
  const devicesOf = db.prepare('SELECT device_id FROM device_event_history WHERE id = ?');
  const remove = db.prepare('DELETE FROM device_event_history WHERE id = ?');
  // Repeated write failures are said once, until a write succeeds again.
  let writeFailing = false;

  return {
    record: (deviceIds, event: DeviceJournalEvent) => {
      const ids = [...new Set(deviceIds)];
      if (ids.length === 0) return;
      const atMs = Date.now();
      try {
        const id = randomUUID();
        const json = JSON.stringify(event);
        db.transaction(() => {
          for (const deviceId of ids) {
            insert.run(id, deviceId, atMs, json);
            capDevice.run(deviceId, deviceId, DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE);
          }
          expire.run(atMs - DEVICE_EVENT_RETENTION_MS);
        });
        writeFailing = false;
      } catch (error) {
        if (!writeFailing) logger.error({ event: 'device_event_write_failed', err: normalizeError(error) });
        writeFailing = true;
      }
    },
    read: (deviceIds, fromMs, toMs) => {
      const byId = new Map<string, SupportReportDeviceEvent>();
      // Insertion order breaks a tie in time, so events of one millisecond keep the order they happened in.
      const recordedAt = new Map<string, number>();
      const batches = deviceIds === 'all'
        ? [loadAll.all(fromMs, toMs)]
        : [...new Set(deviceIds)].map((deviceId) => load.all(deviceId, fromMs, toMs));
      for (const rows of batches) {
        for (const row of rows) {
          if (typeof row.id !== 'string' || byId.has(row.id)) continue;
          const stored = parseStoredEvent(row.event_json);
          if (!stored || typeof row.at_ms !== 'number') {
            logger.error({ event: 'device_event_row_quarantined', id: row.id });
            try { remove.run(row.id); } catch { /* left for the next read; this one goes on */ }
            continue;
          }
          const related = devicesOf.all(row.id).flatMap((entry) => (
            typeof entry.device_id === 'string' ? [entry.device_id] : []));
          byId.set(row.id, { id: row.id, atMs: row.at_ms, deviceIds: related, ...stored });
          recordedAt.set(row.id, Number(row.rowid));
        }
      }
      return [...byId.values()].sort((a, b) => (
        a.atMs - b.atMs || (recordedAt.get(a.id) ?? 0) - (recordedAt.get(b.id) ?? 0)));
    },
  };
};
