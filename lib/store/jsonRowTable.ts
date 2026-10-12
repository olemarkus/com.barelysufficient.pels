/**
 * One table of JSON rows under a text key: the row mechanics the userdata
 * repositories share, so each keeps only its own policy — what a row must hold
 * to be taken, how its rows make the domain state, and its legacy import.
 *
 * `read` answers every row whose JSON parses and that `accept` takes, by key.
 * A row that does not is the store's own damage, regenerable by ruling: it is
 * deleted as read and said once, so it neither costs the rows around it nor
 * lingers to be re-logged on every boot. `write` makes the table hold exactly
 * `next`, upserting the rows whose value differs from the diff base and
 * deleting the keys `next` lacks. The diff base is what the table last read or
 * wrote, read from disk first when it has done neither, so a write can always
 * delete what the caller dropped; it is reread once a transaction has rolled
 * back since it was taken, so a write the database never committed is never
 * taken as done.
 *
 * Values are compared by reference first and by JSON second, so a state that
 * replaces a value when it changes pays nothing for the rows that did not.
 * That is also the one assumption about callers: a value mutated in place
 * between two writes compares equal to itself and is never written. A family
 * whose owner mutates in place keeps a JSON diff base of its own
 * (`lib/dailyBudget/dailyBudgetStateStore.ts`,
 * `lib/diagnostics/deviceDiagnosticsStateStore.ts`).
 *
 * Both run inside the caller's transaction, so a repository with several
 * tables commits them together.
 */
import { getLogger } from '../logging/logger';
import type { UserdataDatabase } from './userdataDatabase';

const storeLogger = getLogger('store');

/** A row's JSON, parsed; `undefined` when it does not parse, which no JSON text produces. */
export const parseJsonRow = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

/** Equal by reference, or else by JSON: free for a value that was not replaced. */
export const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export type JsonRowTable<T> = {
  /** The rows `accept` takes, by key, in key order; the rest are deleted. Throws only on I/O. */
  read(): Map<string, T>;
  /**
   * Make the table hold exactly `next`, touching only the rows that differ.
   * `next` is kept by reference as the next diff base, so it is not changed
   * afterwards.
   */
  write(next: ReadonlyMap<string, T>): void;
};

/**
 * The table `table` with a text primary key and a JSON column, named by
 * `columns`, created when absent. `accept` turns a parsed row into its value,
 * or answers `undefined` for a row that holds none.
 */
export const createJsonRowTable = <T>(
  db: UserdataDatabase,
  table: string,
  [keyColumn, jsonColumn]: readonly [key: string, json: string],
  accept: (value: unknown, key: string) => T | undefined,
): JsonRowTable<T> => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
  ${keyColumn} TEXT PRIMARY KEY NOT NULL, ${jsonColumn} TEXT NOT NULL
) WITHOUT ROWID`);
  const load = db.prepare(`SELECT ${keyColumn} AS key, ${jsonColumn} AS json FROM ${table} ORDER BY ${keyColumn}`);
  const upsert = db.prepare(`INSERT INTO ${table} (${keyColumn}, ${jsonColumn}) VALUES (?, ?) `
    + `ON CONFLICT (${keyColumn}) DO UPDATE SET ${jsonColumn} = excluded.${jsonColumn}`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`);
  let base: { rows: ReadonlyMap<string, T>; rollbacks: number } | null = null;

  const read = (): Map<string, T> => {
    const rows = new Map<string, T>();
    for (const row of load.all() as Array<{ key: string; json: string }>) {
      const parsed = parseJsonRow(row.json);
      const value = parsed === undefined ? undefined : accept(parsed, row.key);
      if (value === undefined) {
        storeLogger.error({ event: 'userdata_row_quarantined', table, key: row.key });
        remove.run(row.key);
      } else {
        rows.set(row.key, value);
      }
    }
    base = { rows: new Map(rows), rollbacks: db.rollbacks() };
    return rows;
  };

  return {
    read,
    write: (next) => {
      const previous = base !== null && base.rollbacks === db.rollbacks() ? base.rows : read();
      for (const [key, value] of next) {
        const before = previous.get(key);
        if (before === undefined || !sameJson(before, value)) upsert.run(key, JSON.stringify(value));
      }
      for (const key of previous.keys()) {
        if (!next.has(key)) remove.run(key);
      }
      base = { rows: next, rollbacks: db.rollbacks() };
    },
  };
};
