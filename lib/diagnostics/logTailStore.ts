/**
 * PELS's own log, kept for problem reports. Homey attaches only the last 100
 * stdout lines to a report, a few minutes on a busy install, so anything older
 * that explains an incident has to come from here.
 *
 * Info, warning and error lines only: debug topics are opt-in and can write
 * megabytes an hour, while the info level writes a few hundred kilobytes a day.
 * A flood is cut at {@link LOG_TAIL_MAX_LINES_PER_EVENT_HOUR} lines of one event
 * per hour, and the cut lines are counted, so a report still says they happened.
 *
 * Rows are written as lines happen, so nothing has to be flushed when the app
 * stops: Homey exits the process before `onUninit` runs.
 */
import type { SupportReportLogLine, SupportReportLogOverflow, SupportReportValue }
  from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { parseJsonRow } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';

export const LOG_TAIL_RETENTION_HOURS = 48;
export const LOG_TAIL_MAX_LINES_PER_EVENT_HOUR = 20;
/** A ceiling on rows whatever the mix of events, so a pathological hour cannot grow the file. */
const LOG_TAIL_MAX_ROWS = 6_000;
const HOUR_MS = 60 * 60 * 1000;

export type LogTailEntry = { atMs: number; level: number; event: string; line: string };

export type LogTailStore = {
  append(entry: LogTailEntry): void;
  /** One more line of `event` left out in the hour starting at `hourStartMs`. */
  countOverflow(hourStartMs: number, event: string): void;
  read(fromMs: number, toMs: number): { lines: SupportReportLogLine[]; overflow: SupportReportLogOverflow[] };
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log_tail (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  level INTEGER NOT NULL,
  event TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_tail_time ON log_tail(at_ms);
CREATE TABLE IF NOT EXISTS log_tail_overflow (
  hour_ms INTEGER NOT NULL,
  event TEXT NOT NULL,
  dropped INTEGER NOT NULL,
  PRIMARY KEY (hour_ms, event)
);
`;

/** Pino's numeric levels, named as a reader expects them. */
const levelName = (level: number): SupportReportLogLine['level'] => {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  return 'info';
};

const isReportValue = (value: unknown): value is SupportReportValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isReportValue);
  return isUnknownRecord(value) && Object.values(value).every(isReportValue);
};

/**
 * Never throws, and never logs: a failure here would be logged through the
 * very destination that feeds this store.
 */
export const createLogTailStore = (db: UserdataDatabase): LogTailStore => {
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO log_tail (at_ms, level, event, line) VALUES (?, ?, ?, ?)');
  const expire = db.prepare('DELETE FROM log_tail WHERE at_ms < ?');
  const cap = db.prepare('DELETE FROM log_tail WHERE seq <= (SELECT MAX(seq) FROM log_tail) - ?');
  const overflow = db.prepare('INSERT INTO log_tail_overflow (hour_ms, event, dropped) VALUES (?, ?, 1) '
    + 'ON CONFLICT (hour_ms, event) DO UPDATE SET dropped = dropped + 1');
  const expireOverflow = db.prepare('DELETE FROM log_tail_overflow WHERE hour_ms < ?');
  const loadLines = db.prepare('SELECT at_ms, level, line FROM log_tail WHERE at_ms >= ? AND at_ms <= ? ORDER BY seq');
  const loadOverflow = db.prepare('SELECT hour_ms, event, dropped FROM log_tail_overflow '
    + 'WHERE hour_ms >= ? AND hour_ms <= ? ORDER BY hour_ms, event');
  const quietly = (work: () => void): void => {
    try { work(); } catch { /* see the note above */ }
  };
  return {
    append: (entry) => quietly(() => db.transaction(() => {
      insert.run(entry.atMs, entry.level, entry.event, entry.line);
      expire.run(entry.atMs - LOG_TAIL_RETENTION_HOURS * HOUR_MS);
      cap.run(LOG_TAIL_MAX_ROWS);
    })),
    countOverflow: (hourStartMs, event) => quietly(() => db.transaction(() => {
      overflow.run(hourStartMs, event);
      expireOverflow.run(hourStartMs - LOG_TAIL_RETENTION_HOURS * HOUR_MS);
    })),
    read: (fromMs, toMs) => ({
      lines: loadLines.all(fromMs, toMs).flatMap((row): SupportReportLogLine[] => {
        const entry = typeof row.line === 'string' ? parseJsonRow(row.line) : undefined;
        if (typeof row.at_ms !== 'number' || typeof row.level !== 'number'
          || !isUnknownRecord(entry) || !isReportValue(entry)) return [];
        return [{ atMs: row.at_ms, level: levelName(row.level), entry }];
      }),
      overflow: loadOverflow.all(fromMs - HOUR_MS, toMs).flatMap((row): SupportReportLogOverflow[] => (
        typeof row.hour_ms === 'number' && typeof row.event === 'string' && typeof row.dropped === 'number'
          ? [{ hourStartMs: row.hour_ms, event: row.event, dropped: row.dropped }] : []
      )),
    }),
  };
};
