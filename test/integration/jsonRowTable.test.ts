import { describe, expect, it } from 'vitest';
import { createJsonRowTable } from '../../lib/store/jsonRowTable';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { captureLogger } from '../utils/loggerCapture';

const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);
const rows = (db: UserdataDatabase, table: string): Array<{ key: string; json: string }> => (
  db.prepare(`SELECT key, json FROM ${table} ORDER BY key`).all() as Array<{ key: string; json: string }>
);

// Accepts any parsed row but a string, so a test can plant one it refuses.
const open = (db: UserdataDatabase, table: string) => createJsonRowTable(
  db, table, ['key', 'json'], (value) => (typeof value === 'string' ? undefined : value),
);

describe('jsonRowTable', () => {
  it('reads back what it wrote in key order, a JSON null included', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    db.transaction(() => open(db, 'family').write(new Map<string, unknown>([['b', { n: 2 }], ['a', null]])));
    expect([...db.transaction(() => open(db, 'family').read())]).toEqual([['a', null], ['b', { n: 2 }]]);
  });

  it('writes only the rows that changed, by reference or by JSON, and deletes the keys dropped', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const table = open(db, 'family');
    const kept = { n: 1 };
    db.transaction(() => table.write(new Map<string, unknown>([['a', kept], ['b', { n: 2 }], ['c', { n: 3 }]])));
    const before = totalChanges(db);
    db.transaction(() => table.write(new Map<string, unknown>([['a', kept], ['b', { n: 2 }], ['d', { n: 4 }]])));
    // `d` inserted, `c` deleted; `a` (same reference) and `b` (same JSON) untouched.
    expect(totalChanges(db) - before).toBe(2);
    expect(rows(db, 'family').map((row) => row.key)).toEqual(['a', 'b', 'd']);
  });

  it('diffs the first write of a fresh table against the rows on disk', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    db.transaction(() => open(db, 'family').write(new Map([['a', 1], ['b', 2]])));
    db.transaction(() => open(db, 'family').write(new Map([['b', 2]])));
    expect(rows(db, 'family')).toEqual([{ key: 'b', json: '2' }]);
  });

  it('deletes a row that does not parse or that the owner refuses, once, keeping the rest', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const table = open(db, 'family');
    db.transaction(() => table.write(new Map([['a', 1]])));
    const insert = db.prepare('INSERT INTO family (key, json) VALUES (?, ?)');
    insert.run('broken', '{not json');
    insert.run('refused', '"a string"');
    const capture = captureLogger();
    try {
      expect([...db.transaction(() => open(db, 'family').read())]).toEqual([['a', 1]]);
      expect(capture.findEvents('userdata_row_quarantined')).toEqual([
        expect.objectContaining({ table: 'family', key: 'broken' }),
        expect.objectContaining({ table: 'family', key: 'refused' }),
      ]);
    } finally {
      capture.restore();
    }
    expect(rows(db, 'family')).toEqual([{ key: 'a', json: '1' }]);
  });

  // A repository writes several tables in one transaction. When a later table
  // throws, the rows an earlier one wrote are rolled back with it, so its diff
  // base must not claim them: the next write rewrites them.
  it('rewrites the rows of a write a later table rolled back', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const first = open(db, 'first');
    const second = open(db, 'second');
    db.transaction(() => {
      first.write(new Map([['a', 1]]));
      second.write(new Map([['a', 1]]));
    });
    const next = new Map([['a', 2]]);
    expect(() => db.transaction(() => {
      first.write(next);
      throw new Error('disk full');
    })).toThrow('disk full');
    expect(rows(db, 'first')).toEqual([{ key: 'a', json: '1' }]);
    db.transaction(() => first.write(next));
    expect(rows(db, 'first')).toEqual([{ key: 'a', json: '2' }]);
    // A rollback anywhere invalidates every base; one that did not move still writes nothing new.
    const before = totalChanges(db);
    db.transaction(() => second.write(new Map([['a', 1]])));
    expect(totalChanges(db) - before).toBe(0);
  });

  it('deletes again a row whose quarantine was rolled back', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const table = open(db, 'family');
    db.prepare('INSERT INTO family (key, json) VALUES (?, ?)').run('broken', '{not json');
    const capture = captureLogger();
    try {
      expect(() => db.transaction(() => {
        table.read();
        throw new Error('disk full');
      })).toThrow('disk full');
      expect(rows(db, 'family').map((row) => row.key)).toEqual(['broken']);
      db.transaction(() => table.write(new Map([['a', 1]])));
    } finally {
      capture.restore();
    }
    expect(rows(db, 'family')).toEqual([{ key: 'a', json: '1' }]);
  });
});
