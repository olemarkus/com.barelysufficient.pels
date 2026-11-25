import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupUserdataIfDue, IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pels-userdata-test-'));

describe('openUserdataDatabase', () => {
  it('creates the file, verifies WAL, and survives a reopen', () => {
    const location = path.join(tempDir(), 'pels.sqlite');
    const db = openUserdataDatabase(location);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v REAL)');
    db.transaction(() => db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1));
    db.close();
    const again = openUserdataDatabase(location);
    expect((again.prepare('SELECT v FROM t WHERE k = ?').get('a') as { v: number }).v).toBe(1);
    again.close();
  });

  // Everything in the file is regenerable by ruling, and a Pro has no shell to
  // repair it from: a file SQLite refuses is set aside, never a boot loop.
  it('quarantines a file that is not a database and starts a fresh one', () => {
    const dir = tempDir();
    const location = path.join(dir, 'pels.sqlite');
    fs.writeFileSync(location, 'this is not a database\n'.repeat(200));
    const db = openUserdataDatabase(location);
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
    db.close();
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('pels.sqlite.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantined[0]!), 'utf8')).toContain('not a database');
  });

  it('a transaction that throws rolls back, and a closed database refuses further work', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run('a');
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    db.close();
    db.close();
    expect(() => db.exec('SELECT 1')).toThrow(/closed/);
  });
});

describe('userdata backups', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let dir: string;
  let location: string;
  let first: string;
  let second: string;
  let db: ReturnType<typeof openUserdataDatabase>;

  const makeDue = (file: string): void => {
    const yesterday = new Date(Date.now() - DAY_MS - 1000);
    fs.utimesSync(file, yesterday, yesterday);
  };

  const readBackup = (file: string): unknown => {
    // Check the published contents without reopening the copy in WAL mode.
    const original = fs.readFileSync(file);
    const verification = path.join(dir, 'verification.sqlite');
    fs.writeFileSync(verification, original);
    const reopened = openUserdataDatabase(verification);
    try {
      return reopened.prepare('SELECT v FROM data').get()?.v;
    } finally {
      reopened.close();
      fs.rmSync(verification);
    }
  };

  beforeEach(() => {
    dir = tempDir();
    location = path.join(dir, 'pels.sqlite');
    first = `${location}.backup-a`;
    second = `${location}.backup-b`;
    db = openUserdataDatabase(location);
    db.exec('CREATE TABLE data(v INTEGER); INSERT INTO data VALUES (1)');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures committed WAL writes, waits a day across restarts, and replaces only the older snapshot', async () => {
    fs.writeFileSync(`${location}.backup-tmp-journal`, 'left by an interrupted backup');
    await backupUserdataIfDue(location);
    expect(readBackup(first)).toBe(1);
    expect(fs.readdirSync(dir).filter((file) => file.includes('.backup-'))).toEqual([path.basename(first)]);

    db.close();
    db = openUserdataDatabase(location);
    db.exec('UPDATE data SET v = 2');
    await backupUserdataIfDue(location);
    expect(fs.existsSync(second)).toBe(false);

    makeDue(first);
    await backupUserdataIfDue(location);
    expect(readBackup(second)).toBe(2);

    makeDue(second);
    db.exec('UPDATE data SET v = 3');
    await backupUserdataIfDue(location);
    expect(readBackup(first)).toBe(3);
    expect(readBackup(second)).toBe(2);
  });

  it('leaves snapshots intact when capacity is low or publishing fails', async () => {
    await backupUserdataIfDue(location);
    makeDue(first);
    db.exec('UPDATE data SET v = 2');
    await backupUserdataIfDue(location);
    makeDue(second);
    db.exec('UPDATE data SET v = 3');
    const statfs = vi.spyOn(fs, 'statfsSync').mockReturnValue({
      bavail: 1, bsize: 4096, blocks: 1000, bfree: 2, type: 0, files: 100, frsize: 4096, ffree: 90,
    });
    await expect(backupUserdataIfDue(location)).resolves.toMatchObject({ reason: 'insufficient_space' });
    expect(readBackup(first)).toBe(1);
    expect(readBackup(second)).toBe(2);
    statfs.mockRestore();

    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('cannot publish');
    });
    await expect(backupUserdataIfDue(location)).rejects.toThrow('cannot publish');
    rename.mockRestore();
    expect(readBackup(first)).toBe(1);
    expect(readBackup(second)).toBe(2);
    const files = fs.readdirSync(dir).filter((file) => file.includes('.backup-')).sort();
    expect(files).toEqual([path.basename(first), path.basename(second)]);
  });

  it('refreshes a future-dated snapshot when there is no protected quarantine', async () => {
    await backupUserdataIfDue(location);
    const future = new Date(Date.now() + DAY_MS);
    fs.utimesSync(first, future, future);
    db.exec('UPDATE data SET v = 2');
    await backupUserdataIfDue(location);
    expect(readBackup(first)).toBe(2);
    await backupUserdataIfDue(location);
    expect(fs.existsSync(second)).toBe(false);
  });

  it('protects pre-corruption backups across a reopen and a clock correction', async () => {
    await backupUserdataIfDue(location);
    makeDue(first);
    db.exec('UPDATE data SET v = 2');
    await backupUserdataIfDue(location);

    db.close();
    fs.writeFileSync(location, 'bad database');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() - 2 * DAY_MS);
      db = openUserdataDatabase(location);
    } finally {
      vi.useRealTimers();
    }
    db.close();
    db = openUserdataDatabase(location);

    makeDue(second);
    await expect(backupUserdataIfDue(location)).resolves.toEqual({ reason: 'quarantined_database' });
    expect(readBackup(first)).toBe(1);
    expect(readBackup(second)).toBe(2);
  });

  it('skips a database larger than the snapshot cap', async () => {
    db.exec('CREATE TABLE big(v BLOB); INSERT INTO big VALUES (zeroblob(17 * 1024 * 1024))');
    await expect(backupUserdataIfDue(location)).resolves.toMatchObject({ reason: 'size_limit' });
    expect(fs.existsSync(first)).toBe(false);
  });

  it('skips a rollback-journal database to avoid blocking live writers', async () => {
    db.exec('PRAGMA journal_mode = DELETE');
    await expect(backupUserdataIfDue(location)).resolves.toEqual({ reason: 'wal_unavailable' });
    expect(fs.existsSync(first)).toBe(false);
  });
});
