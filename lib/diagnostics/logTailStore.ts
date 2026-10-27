/**
 * PELS's own log, kept for problem reports. Homey attaches only the last 100
 * stdout lines to a report, a few minutes on a busy install, so anything older
 * that explains an incident has to come from here.
 *
 * Info, warning and error lines only: debug topics are opt-in and can write
 * megabytes an hour, while the info level writes a few hundred kilobytes a day.
 * Up to {@link LOG_TAIL_RETENTION_HOURS} hours and {@link LOG_TAIL_MAX_ROWS} lines
 * are kept; a flood is cut per hour by the recorder (`logTailRecorder.ts`), which
 * counts what it cut.
 *
 * Rows are written as lines happen, so nothing has to be flushed when the app
 * stops: Homey exits the process before `onUninit` runs. A line logged while
 * another store holds a transaction waits in memory for the next write outside
 * one, because SQLite opens no transaction inside another.
 */
import type { SupportReportLogLine, SupportReportLogOverflow } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { isSupportReportValue } from './supportReportValue';
import { parseJsonRow } from '../store/jsonRowTable';
import type { UserdataDatabase } from '../store/userdataDatabase';

export const LOG_TAIL_RETENTION_HOURS = 48;
export const LOG_TAIL_MAX_LINES_PER_EVENT_HOUR = 20;
/** A ceiling on rows whatever the mix of events, so a pathological day cannot grow the file. */
export const LOG_TAIL_MAX_ROWS = 6_000;
/** Lines held while another store's transaction is open; that is a few at most. */
const MAX_HELD_LINES = 200;
/**
 * Expiry and the row ceiling run once per this many writes, not with every
 * line: at the ceiling each line would otherwise delete a row as it inserts one.
 * The table can hold this many rows over {@link LOG_TAIL_MAX_ROWS} meanwhile.
 */
const TRIM_EVERY_WRITES = 100;
const HOUR_MS = 60 * 60 * 1000;
/** A key's event is the key up to its device (`event` or `event|device`); `?` is a JSON array of events. */
const EVENT_NOT_OMITTED = "substr(key, 1, instr(key || '|', '|') - 1) NOT IN (SELECT value FROM json_each(?))";

/** One kept line. `key` is what the per-hour cap counts: the event, and its device when it names one. */
export type LogTailEntry = { atMs: number; level: number; key: string; line: string };

export type LogTailRead = {
  lines: SupportReportLogLine[];
  overflow: SupportReportLogOverflow[];
  /** Kept lines in the window older than the newest that fit the byte budget. */
  leftOut: number;
};

export type LogTailStore = {
  append(entry: LogTailEntry): void;
  /** `dropped` lines of `key` left out so far in the hour starting at `hourStartMs`. */
  recordOverflow(hourStartMs: number, key: string, dropped: number): void;
  /** How many lines of each key are kept since `fromMs`, to resume the per-hour cap after a restart. */
  countSince(fromMs: number): Map<string, number>;
  /** The newest kept lines in the window whose JSON fits `maxBytes`, oldest first, without lines of `omittedEvents`. */
  read(fromMs: number, toMs: number, maxBytes: number, omittedEvents: readonly string[]): LogTailRead;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log_tail (
  seq INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  level INTEGER NOT NULL,
  key TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_tail_time ON log_tail(at_ms);
CREATE TABLE IF NOT EXISTS log_tail_overflow (
  hour_ms INTEGER NOT NULL,
  key TEXT NOT NULL,
  dropped INTEGER NOT NULL,
  PRIMARY KEY (hour_ms, key)
);
`;

/** Pino's numeric levels, named as a reader expects them. */
const levelName = (level: number): SupportReportLogLine['level'] => {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  return 'info';
};

const toLine = (row: Record<string, unknown>): SupportReportLogLine[] => {
  const entry = typeof row.line === 'string' ? parseJsonRow(row.line) : undefined;
  if (typeof row.at_ms !== 'number' || typeof row.level !== 'number'
    || !isUnknownRecord(entry) || !isSupportReportValue(entry)) return [];
  return [{ atMs: row.at_ms, level: levelName(row.level), entry }];
};

/**
 * Never throws, and never logs: a failure here would be logged through the
 * very destination that feeds this store.
 */
export const createLogTailStore = (db: UserdataDatabase): LogTailStore => {
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO log_tail (at_ms, level, key, line) VALUES (?, ?, ?, ?)');
  const expire = db.prepare('DELETE FROM log_tail WHERE at_ms < ?');
  const cap = db.prepare('DELETE FROM log_tail WHERE seq <= (SELECT MAX(seq) FROM log_tail) - ?');
  const overflow = db.prepare('INSERT INTO log_tail_overflow (hour_ms, key, dropped) VALUES (?, ?, ?) '
    + 'ON CONFLICT (hour_ms, key) DO UPDATE SET dropped = MAX(dropped, excluded.dropped)');
  const expireOverflow = db.prepare('DELETE FROM log_tail_overflow WHERE hour_ms < ?');
  const counts = db.prepare('SELECT key, COUNT(*) AS lines FROM log_tail WHERE at_ms >= ? GROUP BY key');
  const inReadWindow = `at_ms >= ? AND at_ms <= ? AND ${EVENT_NOT_OMITTED}`;
  // The newest lines first, with the running size of every line up to each.
  const newest = db.prepare('SELECT at_ms, level, line FROM (SELECT seq, at_ms, level, line, '
    + `SUM(length(line)) OVER (ORDER BY seq DESC) AS running FROM log_tail WHERE ${inReadWindow}) `
    + 'WHERE running <= ? ORDER BY seq');
  const inWindow = db.prepare(`SELECT COUNT(*) AS lines FROM log_tail WHERE ${inReadWindow}`);
  const loadOverflow = db.prepare('SELECT hour_ms, key, dropped FROM log_tail_overflow '
    + `WHERE hour_ms >= ? AND hour_ms <= ? AND ${EVENT_NOT_OMITTED} ORDER BY hour_ms, key`);
  let held: LogTailEntry[] = [];
  // The first write trims: the app may have been down longer than retention.
  let writesSinceTrim = TRIM_EVERY_WRITES;
  const quietly = <T>(work: () => T, fallback: T): T => {
    try { return work(); } catch { return fallback; } // See the note above.
  };
  const write = (entries: readonly LogTailEntry[]): void => db.transaction(() => {
    for (const entry of entries) insert.run(entry.atMs, entry.level, entry.key, entry.line);
    writesSinceTrim += 1;
    if (writesSinceTrim < TRIM_EVERY_WRITES) return;
    writesSinceTrim = 0;
    const newestAtMs = entries.at(-1)?.atMs ?? 0;
    expire.run(newestAtMs - LOG_TAIL_RETENTION_HOURS * HOUR_MS);
    cap.run(LOG_TAIL_MAX_ROWS);
  });
  return {
    append: (entry) => {
      if (db.inTransaction()) {
        if (held.length < MAX_HELD_LINES) held = [...held, entry];
        return;
      }
      const entries = held.length === 0 ? [entry] : [...held, entry];
      held = [];
      quietly(() => write(entries), undefined);
    },
    recordOverflow: (hourStartMs, key, dropped) => {
      if (db.inTransaction()) return;
      quietly(() => db.transaction(() => {
        overflow.run(hourStartMs, key, dropped);
        expireOverflow.run(hourStartMs - LOG_TAIL_RETENTION_HOURS * HOUR_MS);
      }), undefined);
    },
    countSince: (fromMs) => quietly(() => new Map(counts.all(fromMs).flatMap((row): Array<[string, number]> => (
      typeof row.key === 'string' && typeof row.lines === 'number' ? [[row.key, row.lines]] : []
    ))), new Map<string, number>()),
    read: (windowFromMs, toMs, maxBytes, omittedEvents) => {
      // Expiry runs only every so many writes, so a read leaves out what it would have removed.
      const fromMs = Math.max(windowFromMs, toMs - LOG_TAIL_RETENTION_HOURS * HOUR_MS);
      const omitted = JSON.stringify(omittedEvents);
      const rows = newest.all(fromMs, toMs, omitted, maxBytes);
      const total = inWindow.get(fromMs, toMs, omitted)?.lines;
      return {
        // A damaged row is left out of the report, not counted as left out for size.
        lines: rows.flatMap(toLine),
        overflow: loadOverflow.all(fromMs - HOUR_MS, toMs, omitted).flatMap((row): SupportReportLogOverflow[] => (
          typeof row.hour_ms === 'number' && typeof row.key === 'string' && typeof row.dropped === 'number'
            ? [{ hourStartMs: row.hour_ms, key: row.key, dropped: row.dropped }] : []
        )),
        leftOut: typeof total === 'number' ? Math.max(0, total - rows.length) : 0,
      };
    },
  };
};
