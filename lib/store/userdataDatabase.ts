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
import path from 'node:path';
import { backup, DatabaseSync, type StatementSync } from 'node:sqlite';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';

const storeLogger = getLogger('store');

/** A prepared statement, re-exported so no repository has to name `node:sqlite` itself. */
export type PreparedStatement = StatementSync;

/** Where the Homey app-runner mounts the app's persistent directory. */
/** Where Homey bind-mounts the per-app userdata directory, for store installs and `homey app run --remote` alike. */
const USERDATA_DIR = '/userdata';
const USERDATA_DATABASE_FILE = 'pels.sqlite';
const QUARANTINE_SUFFIX = '.corrupt-';
const PROTECT_BACKUPS_SUFFIX = '.preserve-backups';
const BACKUP_BOOT_DELAY_MS = 5 * 60 * 1000;
const BACKUP_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const BACKUP_INTERVAL_MS = 24 * BACKUP_CHECK_INTERVAL_MS;
const BACKUP_MAX_BYTES = 16 * 1024 * 1024;
const BACKUP_FREE_RESERVE_BYTES = 64 * 1024 * 1024;
/** SQLite's in-memory database, for tests and for the harnesses. */
export const IN_MEMORY_DATABASE = ':memory:';

export type UserdataDatabase = {
  readonly location: string;
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  /** Run `work` inside one transaction; a throw rolls it back and rethrows. */
  transaction<T>(work: () => T): T;
  /** Whether a transaction is open: a write that needs its own must wait until it closes. */
  inTransaction(): boolean;
  /**
   * How many transactions have rolled back since the database opened. A
   * repository that keeps what its rows hold notes this with its copy and
   * rereads its rows once it has moved, so a write the database rolled back
   * is never taken as done (`jsonRowTable.ts`).
   */
  rollbacks(): number;
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

const backupSlots = (location: string): [string, string] => [`${location}.backup-a`, `${location}.backup-b`];

/** Move a damaged file (and its WAL/SHM sidecars) out of the way, keeping it for a post-mortem. */
const quarantineDamagedFile = (location: string): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Record protection in the quarantined filename itself so it survives restart
  // and clock changes without a second write that could fail during recovery.
  const protect = backupSlots(location).some((file) => fs.existsSync(file)) ? PROTECT_BACKUPS_SUFFIX : '';
  const suffix = `${QUARANTINE_SUFFIX}${timestamp}${protect}`;
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
  let rollbacks = 0;
  let transactionOpen = false;
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
      transactionOpen = true;
      try {
        const result = work();
        live.exec('COMMIT');
        return result;
      } catch (error) {
        rollbacks += 1;
        live.exec('ROLLBACK');
        throw error;
      } finally {
        transactionOpen = false;
      }
    },
    inTransaction: () => transactionOpen,
    rollbacks: () => rollbacks,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
};

const cleanupBackupTemp = (temp: string): void => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(`${temp}${suffix}`, { force: true });
  }
};

const verifyBackup = (temp: string): void => {
  const snapshot = new DatabaseSync(temp);
  try {
    // The published snapshot must be a standalone file, even on a WAL source.
    if (snapshot.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete'
      || snapshot.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') {
      throw new Error('SQLite snapshot verification failed');
    }
  } finally {
    snapshot.close();
  }
};

type BackupSkip =
  | { reason: 'wal_unavailable' | 'quarantined_database' }
  | { reason: 'size_limit' | 'insufficient_space'; bytes: number; freeBytes: number };

const availableBackupBytes = (dir: string): number => {
  const { bavail, bsize } = fs.statfsSync(dir);
  return bavail * bsize;
};

const writeBackup = async (location: string, dir: string, temp: string): Promise<BackupSkip | undefined> => {
  const source = new DatabaseSync(location, { readOnly: true });
  try {
    if (source.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') {
      return { reason: 'wal_unavailable' };
    }

    // Pin the snapshot before sizing it. This read transaction allows live WAL writes
    // and keeps them from changing which pages the backup reads between steps.
    source.exec('BEGIN; SELECT 1 FROM sqlite_schema LIMIT 1;');
    const { bytes } = source.prepare(
      'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()',
    ).get() as { bytes: number };
    const freeBytes = availableBackupBytes(dir);
    if (bytes > BACKUP_MAX_BYTES || freeBytes < bytes + BACKUP_FREE_RESERVE_BYTES) {
      return {
        reason: bytes > BACKUP_MAX_BYTES ? 'size_limit' : 'insufficient_space',
        bytes,
        freeBytes,
      };
    }
    await backup(source, temp);
    return undefined;
  } finally {
    source.close();
  }
};

const hasProtectedQuarantine = (location: string, dir: string): boolean => {
  const prefix = `${path.basename(location)}${QUARANTINE_SUFFIX}`;
  return fs.readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith(PROTECT_BACKUPS_SUFFIX));
};

const syncPath = (location: string): void => {
  const fd = fs.openSync(location, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

/** Preserve up to two daily snapshots. The app owns the only writer of the backup slots. */
export const backupUserdataIfDue = async (location: string): Promise<BackupSkip | undefined> => {
  const dir = path.dirname(location);
  const temp = `${location}.backup-tmp`;
  cleanupBackupTemp(temp);
  const [first, second] = backupSlots(location);
  const firstMtime = fs.statSync(first, { throwIfNoEntry: false })?.mtimeMs ?? -Infinity;
  const secondMtime = fs.statSync(second, { throwIfNoEntry: false })?.mtimeMs ?? -Infinity;
  const newestMtime = Math.max(firstMtime, secondMtime);
  const ageMs = Date.now() - newestMtime;
  const clockMovedBack = ageMs < -BACKUP_FUTURE_TOLERANCE_MS;
  if (!clockMovedBack && ageMs < BACKUP_INTERVAL_MS) return undefined;
  if (Number.isFinite(newestMtime) && hasProtectedQuarantine(location, dir)) {
    return { reason: 'quarantined_database' };
  }

  try {
    const skip = await writeBackup(location, dir, temp);
    if (skip) return skip;
    verifyBackup(temp);
    const { size } = fs.statSync(temp);
    syncPath(temp);
    // Other writers can consume space while SQLite copies the snapshot.
    const freeBytes = availableBackupBytes(dir);
    if (freeBytes < BACKUP_FREE_RESERVE_BYTES) {
      return { reason: 'insufficient_space', bytes: size, freeBytes };
    }
    // Replace a future-dated slot first so it cannot force a write every hour.
    const replaceFirst = clockMovedBack ? firstMtime >= secondMtime : firstMtime <= secondMtime;
    fs.renameSync(temp, replaceFirst ? first : second);
    syncPath(dir);
    storeLogger.info({ event: 'userdata_backup_created', bytes: size });
    return undefined;
  } finally {
    cleanupBackupTemp(temp);
  }
};

const scheduleBackups = (location: string): (() => void) => {
  let stopped = false;
  let lastSkip: BackupSkip['reason'] | undefined;
  let timer: NodeJS.Timeout;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void backupUserdataIfDue(location).then((skip) => {
        if (skip && skip.reason !== lastSkip) {
          storeLogger.warn({ event: 'userdata_backup_skipped', ...skip });
        }
        lastSkip = skip?.reason;
      }).catch((error: unknown) => {
        lastSkip = undefined;
        storeLogger.warn({ event: 'userdata_backup_failed', err: normalizeError(error) });
      }).finally(() => schedule(BACKUP_CHECK_INTERVAL_MS));
    }, delayMs);
    timer.unref();
  };
  schedule(BACKUP_BOOT_DELAY_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

/** The app's one database file, at the production path. */
export const openAppUserdataDatabase = (): UserdataDatabase => {
  const db = openUserdataDatabase(path.join(USERDATA_DIR, USERDATA_DATABASE_FILE));
  const stopBackups = scheduleBackups(db.location);
  return {
    ...db,
    close: () => {
      stopBackups();
      db.close();
    },
  };
};
