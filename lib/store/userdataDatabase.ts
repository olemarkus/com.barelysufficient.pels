/**
 * The app's one SQLite file under Homey's per-app `/userdata` directory.
 *
 * Ownership: this module is the only place that opens the file or touches
 * `node:sqlite`; every data family that lives there gets a repository beside
 * its domain (`lib/power/trackerStore.ts` first) that takes the open database
 * and owns its own tables. Nothing else imports `node:sqlite`.
 *
 * Why a file, and why not `homey.settings`: the SDK's `ManagerSettings.set`
 * re-serialises and ships the ENTIRE settings object to Homey core on every
 * write of any key. With the history series in there PELS's object was
 * ~2 MB and written ~112 times an hour, which is the allocation churn behind
 * the memory watchdog kills. `/userdata` is a directory bind-mounted into the
 * app's container: a write costs the bytes written, crosses no serializer and
 * no socket, and core never sees it. Owner ruling 2026-09-07: settings hold
 * configuration and mission-critical state; history, learned data and caches
 * live here.
 *
 * Two failure modes, two answers. A MISSING directory is loud: it exists for
 * a store install, for `homey app run --remote` and for a local docker run
 * alike (the CLI mounts one from `~/.athom-cli`), so a runtime without it is
 * not one this app claims to serve, and opening fails at boot rather than
 * quietly running without history. A DAMAGED file is not: everything in it is
 * regenerable by ruling, a Pro has no shell to repair it from, and the only
 * remedy an owner would have left is uninstalling the app — which deletes the
 * settings too. So a file SQLite refuses to open is set aside under a
 * timestamped name and a fresh one is started, logged once at error.
 */
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { getLogger } from '../logging/logger';

const storeLogger = getLogger('store');

/** A prepared statement, re-exported so no repository has to name `node:sqlite` itself. */
export type PreparedStatement = StatementSync;

/** Where the Homey app-runner mounts the app's persistent directory. */
export const USERDATA_DIR = '/userdata';
export const USERDATA_DATABASE_FILE = 'pels.sqlite';
/** SQLite's in-memory database, for tests and for the harnesses. */
export const IN_MEMORY_DATABASE = ':memory:';

export type UserdataDatabase = {
  readonly location: string;
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  /** Run `work` inside one transaction; a throw rolls it back and rethrows. */
  transaction<T>(work: () => T): T;
  close(): void;
};

/**
 * SQLite primary result codes that mean "this file is not a database I can
 * use": CORRUPT (11), IOERR (10), FULL (13), NOTADB (26). `node:sqlite` raises
 * a generic `ERR_SQLITE_ERROR` and carries the SQLite code in `errcode`, with
 * any extended code in the high bits — so the low byte is what is classified.
 */
const DAMAGED_FILE_RESULT_CODES = new Set([10, 11, 13, 26]);

const isDamagedFileError = (error: unknown): boolean => {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' && DAMAGED_FILE_RESULT_CODES.has(errcode & 0xff);
};

const openWithPragmas = (location: string): DatabaseSync => {
  const db = new DatabaseSync(location);
  try {
    // WAL so a power cut mid-commit leaves the last committed state, and a
    // `NORMAL` sync so the eMMC is not fsynced on every row. That pairing is
    // only safe IN WAL mode — in rollback mode `NORMAL` is the combination
    // SQLite documents as corruptible by a power cut — and the pragma answers
    // with the mode it could give rather than throwing, so it is verified.
    const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: unknown } | undefined;
    const journalMode = typeof mode?.journal_mode === 'string' ? mode.journal_mode.toLowerCase() : 'unknown';
    if (journalMode === 'wal' || location === IN_MEMORY_DATABASE) {
      db.exec('PRAGMA synchronous = NORMAL');
    } else {
      storeLogger.error({ event: 'userdata_database_wal_unavailable', location, journalMode });
      db.exec('PRAGMA synchronous = FULL');
    }
    // A 2 MB page cache — small on purpose, it counts against the same RSS ceiling.
    db.exec('PRAGMA cache_size = -2048');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

/** Move a damaged file (and its WAL/SHM sidecars) out of the way, keeping it for a post-mortem. */
const quarantineDamagedFile = (location: string): string => {
  const suffix = `.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (const sidecar of ['', '-wal', '-shm']) {
    const from = `${location}${sidecar}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${location}${suffix}${sidecar}`);
  }
  return `${location}${suffix}`;
};

/**
 * Open (creating if absent) the database at `location`. A file that exists but
 * cannot be opened as a database is quarantined and replaced; a location that
 * cannot be created at all throws.
 */
export const openUserdataDatabase = (location: string): UserdataDatabase => {
  let db: DatabaseSync;
  try {
    db = openWithPragmas(location);
  } catch (error) {
    if (location === IN_MEMORY_DATABASE || !fs.existsSync(location) || !isDamagedFileError(error)) throw error;
    const quarantinedTo = quarantineDamagedFile(location);
    storeLogger.error({
      event: 'userdata_database_quarantined',
      location,
      quarantinedTo,
      err: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
    });
    db = openWithPragmas(location);
  }
  let closed = false;
  const open = (): DatabaseSync => {
    if (closed) throw new Error(`userdata database at ${location} is closed`);
    return db;
  };
  return {
    location,
    prepare: (sql) => open().prepare(sql),
    exec: (sql) => open().exec(sql),
    transaction: (work) => {
      const live = open();
      live.exec('BEGIN');
      try {
        const result = work();
        live.exec('COMMIT');
        return result;
      } catch (error) {
        live.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
};
