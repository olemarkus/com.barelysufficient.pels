import type { UserdataDatabase } from '../store/userdataDatabase';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

/** One durable consumption receipt per configured schedule, never an execution queue. */
export type ScheduleReceipt = { localOccurrence: string; consumedAtMs: number; lastResult: string };
export type ScheduleReceiptStore = {
  read(id: string): ScheduleReceipt | undefined;
  write(id: string, receipt: ScheduleReceipt): void;
  delete(id: string): void;
};

const parseReceipt = (raw: unknown): ScheduleReceipt | undefined => {
  if (!isUnknownRecord(raw)
    || typeof raw.localOccurrence !== 'string'
    || !/^\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}$/.test(raw.localOccurrence)
    || typeof raw.consumedAtMs !== 'number' || !Number.isFinite(raw.consumedAtMs)
    || typeof raw.lastResult !== 'string') return undefined;
  return { localOccurrence: raw.localOccurrence, consumedAtMs: raw.consumedAtMs, lastResult: raw.lastResult };
};

export const createScheduleReceiptStore = (db: UserdataDatabase): ScheduleReceiptStore => {
  db.exec('CREATE TABLE IF NOT EXISTS schedule_receipts '
    + '(id TEXT PRIMARY KEY NOT NULL, receipt TEXT NOT NULL) WITHOUT ROWID');
  const read = db.prepare('SELECT receipt FROM schedule_receipts WHERE id = ?');
  const write = db.prepare('INSERT INTO schedule_receipts (id, receipt) VALUES (?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET receipt = excluded.receipt');
  const remove = db.prepare('DELETE FROM schedule_receipts WHERE id = ?');
  return {
    read: (id) => {
      const row: unknown = read.get(id);
      if (!isUnknownRecord(row) || typeof row.receipt !== 'string') return undefined;
      // A malformed durable receipt must stop execution, never become permission to replay.
      const receipt = parseReceipt(JSON.parse(row.receipt) as unknown);
      if (!receipt) throw new Error('Schedule receipt is unavailable');
      return receipt;
    },
    write: (id, receipt) => { write.run(id, JSON.stringify(receipt)); },
    delete: (id) => { remove.run(id); },
  };
};
