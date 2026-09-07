import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

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
