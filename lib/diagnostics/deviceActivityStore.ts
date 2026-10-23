import { parseDeviceActivityEntry } from '../../packages/shared-domain/src/deviceActivity';
import { getLogger } from '../logging/logger';
import { parseJsonRow } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';
import {
  DEVICE_ACTIVITY_MAX_ENTRIES,
  DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE,
  DEVICE_ACTIVITY_RETENTION_MS,
  type DeviceActivityStore,
} from './deviceActivityHistory';

const logger = getLogger('diagnostics/device-activity');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_activity_history (
  id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (home_id, id)
);
CREATE INDEX IF NOT EXISTS device_activity_history_home_time
  ON device_activity_history(home_id, at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS device_activity_history_age ON device_activity_history(at_ms);
`;

/** One row per event in the app's existing SQLite database, partitioned by home. */
export const createDeviceActivityStore = (db: UserdataDatabase, homeId: string): DeviceActivityStore => {
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO device_activity_history '
    + '(id, home_id, device_id, at_ms, entry_json) VALUES (?, ?, ?, ?, ?)');
  const load = db.prepare('SELECT id, device_id, at_ms, entry_json FROM device_activity_history '
    + 'WHERE home_id = ? ORDER BY at_ms DESC, id DESC');
  const remove = db.prepare('DELETE FROM device_activity_history WHERE home_id = ? AND id = ?');
  const expire = db.prepare('DELETE FROM device_activity_history WHERE at_ms < ?');
  const capDevices = db.prepare('DELETE FROM device_activity_history WHERE home_id = ? AND id IN ('
    + 'SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY at_ms DESC, id DESC) AS rank '
    + 'FROM device_activity_history WHERE home_id = ?) WHERE rank > ?)');
  const capTotal = db.prepare('DELETE FROM device_activity_history WHERE home_id = ? AND id IN ('
    + 'SELECT id FROM device_activity_history WHERE home_id = ? ORDER BY at_ms DESC, id DESC LIMIT -1 OFFSET ?)');
  const prune = (nowMs: number): void => {
    // The age policy also cleans up homes that no longer have a running recorder.
    expire.run(nowMs - DEVICE_ACTIVITY_RETENTION_MS);
    capDevices.run(homeId, homeId, DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE);
    capTotal.run(homeId, homeId, DEVICE_ACTIVITY_MAX_ENTRIES);
  };
  return {
    append: (entries, nowMs) => db.transaction(() => {
      for (const entry of entries) insert.run(entry.id, homeId, entry.deviceId, entry.atMs, JSON.stringify(entry));
      prune(nowMs);
    }),
    read: (nowMs) => db.transaction(() => {
      prune(nowMs);
      return load.all(homeId).flatMap((row) => {
        const entry = typeof row.entry_json === 'string'
          ? parseDeviceActivityEntry(parseJsonRow(row.entry_json)) : undefined;
        if (entry && entry.id === row.id && entry.deviceId === row.device_id && entry.atMs === row.at_ms) {
          return [entry];
        }
        logger.error({ event: 'device_activity_row_quarantined', id: row.id });
        if (row.id !== undefined) remove.run(homeId, row.id);
        return [];
      });
    }),
  };
};
