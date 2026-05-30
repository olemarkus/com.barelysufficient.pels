import { describe, expect, it } from 'vitest';
import {
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
  clearObjectiveForDevice,
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
  readObjectiveForDevice,
  writeObjectiveForDevice,
  type ObjectiveSettingsStore,
} from '../lib/objectives/deferredObjectives/objectiveStore';
import {
  DEFERRED_OBJECTIVES_PERKEY_MIGRATED,
  DEFERRED_OBJECTIVES_SETTINGS,
} from '../lib/utils/settingsKeys';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from '../lib/objectives/deferredObjectives/settings';

const DEADLINE_MS = Date.UTC(2026, 0, 1, 18, 0, 0);

const evEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: DEADLINE_MS,
};

const tempEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 65,
  deadlineAtMs: DEADLINE_MS,
};

const keyFor = (deviceId: string): string => `${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`;

// In-memory store mirroring `homey.settings` / the test `MockSettings`. The key
// list derives from the backing map, so set/unset keep getKeys() consistent.
// A `forceEmptyKeys` toggle simulates the transient-empty SDK read.
class FakeStore implements ObjectiveSettingsStore {
  readonly map = new Map<string, unknown>();
  forceEmptyKeys = false;

  get(key: string): unknown { return this.map.get(key); }
  set(key: string, value: unknown): void { this.map.set(key, value); }
  unset(key: string): void { this.map.delete(key); }
  getKeys(): string[] { return this.forceEmptyKeys ? [] : [...this.map.keys()]; }
}

const blob = (
  entries: Record<string, DeferredObjectiveSettingsEntry>,
): DeferredObjectiveSettingsV1 => ({ version: 1, objectivesByDeviceId: entries });

describe('objectiveStore round-trips', () => {
  it('write → read one device', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
  });

  it('read returns undefined for an absent device', () => {
    expect(readObjectiveForDevice(new FakeStore(), 'nope')).toBeUndefined();
  });

  it('read returns undefined for a malformed stored value', () => {
    const store = new FakeStore();
    store.set(keyFor('ev-1'), { enabled: 'yes' }); // not a valid entry
    expect(readObjectiveForDevice(store, 'ev-1')).toBeUndefined();
  });

  it('clear removes the device key', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    clearObjectiveForDevice(store, 'ev-1');
    expect(readObjectiveForDevice(store, 'ev-1')).toBeUndefined();
    expect(store.getKeys()).not.toContain(keyFor('ev-1'));
  });

  it('readAll assembles the V1 map from per-device keys', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    writeObjectiveForDevice(store, 'heater-1', tempEntry);
    expect(readAllObjectives(store)).toEqual(blob({ 'ev-1': evEntry, 'heater-1': tempEntry }));
  });

  it('readAll skips malformed entries and foreign (non-prefixed) keys', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    store.set(keyFor('bad-1'), { enabled: 'nope' }); // malformed → skipped
    store.set('capacity_limit_kw', 5); // foreign key → not matched by prefix
    store.set('deferred_objectives', blob({ 'ghost': evEntry })); // plural blob → NOT matched
    expect(readAllObjectives(store)).toEqual(blob({ 'ev-1': evEntry }));
  });

  it('PER-KEY ISOLATION: writing device A leaves device B\'s key untouched', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'a', evEntry);
    writeObjectiveForDevice(store, 'b', tempEntry);
    writeObjectiveForDevice(store, 'a', { ...evEntry, targetPercent: 55 });
    expect(readObjectiveForDevice(store, 'b')).toEqual(tempEntry); // B never moved
    clearObjectiveForDevice(store, 'a');
    expect(readObjectiveForDevice(store, 'b')).toEqual(tempEntry); // still untouched
  });

  it('transient-empty getKeys() yields an empty readAll, then recovers on the next read', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    store.forceEmptyKeys = true;
    // One bad cycle: no objectives surfaced, but NOTHING is deleted from disk.
    expect(readAllObjectives(store)).toEqual(blob({}));
    expect(store.map.has(keyFor('ev-1'))).toBe(true);
    // Next clean read recovers the entry.
    store.forceEmptyKeys = false;
    expect(readAllObjectives(store)).toEqual(blob({ 'ev-1': evEntry }));
  });
});

describe('migrateBlobToPerKeyIfNeeded', () => {
  it('copies blob entries to per-device keys and sets the marker', () => {
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry, 'heater-1': tempEntry }));
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual(tempEntry);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
    // The blob is CONSUMED (unset) once copied, so a later marker-read flake
    // can't re-read it and resurrect a since-cleared device.
    expect(store.get(DEFERRED_OBJECTIVES_SETTINGS)).toBeUndefined();
    expect(store.getKeys()).not.toContain(DEFERRED_OBJECTIVES_SETTINGS);
  });

  it('is idempotent: running twice produces the same result, marker stays set', () => {
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry }));
    migrateBlobToPerKeyIfNeeded(store);
    const after1 = readAllObjectives(store);
    // A second pass is a no-op (marker truthy → early return).
    migrateBlobToPerKeyIfNeeded(store);
    expect(readAllObjectives(store)).toEqual(after1);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
  });

  it('ABANDON-GRACE: empty getKeys() does NOT migrate and does NOT set the marker (retries)', () => {
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry }));
    store.forceEmptyKeys = true; // transient-empty store read
    migrateBlobToPerKeyIfNeeded(store);
    // No per-key written, marker NOT set — so the next boot retries.
    expect(store.map.has(keyFor('ev-1'))).toBe(false);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBeUndefined();
    // Next boot, store readable: migration now runs.
    store.forceEmptyKeys = false;
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
  });

  it('NO-RESURRECTION: a device cleared after migration stays cleared on re-run', () => {
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry }));
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    // User clears the device's per-key (the blob was consumed at migration).
    clearObjectiveForDevice(store, 'ev-1');
    // Re-run after the marker is set → no-op; nothing can resurrect it.
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toBeUndefined();
    expect(readAllObjectives(store)).toEqual(blob({}));
  });

  it('NO-RESURRECTION on marker flake even with ZERO surviving per-keys (blob was consumed)', () => {
    // The hole the surviving-per-key short-circuit alone could NOT close: the
    // user clears their ONLY task (no per-key survives) AND the marker `get`
    // flakes to falsy on reboot. Because the blob was consumed (unset) during
    // migration, there is no source to re-read — step 4 (blob absent) re-asserts
    // the marker and the cleared task stays gone.
    const store = new FakeStore();
    store.set('capacity_limit_kw', 5); // a real install always has other settings keys
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry }));
    migrateBlobToPerKeyIfNeeded(store);
    clearObjectiveForDevice(store, 'ev-1'); // user clears their only task → zero per-keys
    expect(store.getKeys().some((k) => k.startsWith(keyFor('')))).toBe(false);
    store.unset(DEFERRED_OBJECTIVES_PERKEY_MIGRATED); // simulate a flaky marker read
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toBeUndefined(); // NOT resurrected
    expect(readAllObjectives(store)).toEqual(blob({}));
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true); // marker re-asserted
  });

  it('PARTIAL-MIGRATION: a crash after copying some keys (blob not yet consumed) finishes the rest', () => {
    // The app crashed mid-copy on a prior boot: heater-1's per-key was written
    // but the blob was not yet unset and the marker not set. The blob still holds
    // BOTH devices. This boot must finish copying ev-1 (absent-only) rather than
    // mark done with ev-1 left behind, and must not clobber the already-copied
    // heater-1.
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry, 'heater-1': tempEntry }));
    writeObjectiveForDevice(store, 'heater-1', tempEntry); // simulate the partial copy
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry); // the missing one got copied
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual(tempEntry);
    expect(store.get(DEFERRED_OBJECTIVES_SETTINGS)).toBeUndefined(); // blob now consumed
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
  });

  it('GENUINELY-EMPTY blob (store readable) is consumed + marked, so the migration completes', () => {
    // getKeys() is non-empty and lists the blob key (step 2 + 3 passed → the store
    // is loaded, so this is NOT a store-wide flake). A blob that reads zero entries
    // here is genuinely empty (e.g. the user cleared their last legacy task before
    // upgrading). It must consume + mark — otherwise the marker stays unset forever
    // and the marker-gated startup back-fill never runs.
    const store = new FakeStore();
    store.set('capacity_limit_kw', 5); // a real store always has other keys
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({})); // present, normalizes to no entries
    migrateBlobToPerKeyIfNeeded(store);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true); // marked → migration complete
    expect(store.get(DEFERRED_OBJECTIVES_SETTINGS)).toBeUndefined(); // consumed
    expect(readAllObjectives(store)).toEqual(blob({})); // no objectives, no resurrection
  });

  it('FLAKY blob read (key listed but value reads undefined) does NOT consume or mark — retries', () => {
    // The blob key IS in getKeys (store readable), but its value transiently reads
    // undefined — the same Homey-settings flake the per-key write guards refuse on.
    // Consuming here would erase the only legacy copy before any per-key is written
    // (data loss on an upgrade with existing tasks). It must retry next boot instead.
    const store = new FakeStore();
    store.set('capacity_limit_kw', 5); // store readable (getKeys non-empty)
    store.set(DEFERRED_OBJECTIVES_SETTINGS, undefined); // key present, value reads undefined
    expect(store.getKeys()).toContain(DEFERRED_OBJECTIVES_SETTINGS);
    migrateBlobToPerKeyIfNeeded(store);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBeUndefined(); // NOT marked
    expect(store.getKeys()).toContain(DEFERRED_OBJECTIVES_SETTINGS); // NOT consumed/erased
    // Next boot the value reads back its real entries → migrates normally.
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry }));
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
  });

  it('NO-RESURRECTION even when the marker read flakes: the consumed blob is gone', () => {
    // The no-resurrection guarantee must not rest on the marker `get` alone — a
    // single SDK read can transiently return falsy. After migration the blob is
    // consumed (unset), so even when the marker get flakes to undefined AND only
    // some per-keys survive, the migration finds no source blob (step 3) and
    // re-asserts the marker without resurrecting the cleared ev-1.
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry, 'heater-1': tempEntry }));
    migrateBlobToPerKeyIfNeeded(store);
    expect(store.get(DEFERRED_OBJECTIVES_SETTINGS)).toBeUndefined(); // blob consumed
    clearObjectiveForDevice(store, 'ev-1'); // user clears ev-1; heater-1 survives
    store.unset(DEFERRED_OBJECTIVES_PERKEY_MIGRATED); // simulate a flaky marker read
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toBeUndefined(); // NOT resurrected
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual(tempEntry);
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true); // marker re-asserted
  });

  it('ABSENT-ONLY: never overwrites a per-key that already exists with the blob value', () => {
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry }));
    // A newer per-key already exists (e.g. written between boots).
    const newer: DeferredObjectiveSettingsEntry = { ...evEntry, targetPercent: 55 };
    writeObjectiveForDevice(store, 'ev-1', newer);
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(newer); // blob did NOT clobber it
  });

  it('PRESENCE-BASED resume: a present per-key whose value reads undefined is NOT re-copied from the blob', () => {
    const store = new FakeStore();
    store.set(DEFERRED_OBJECTIVES_SETTINGS, blob({ 'ev-1': evEntry, 'heater-1': tempEntry }));
    // ev-1's per-key exists from a prior partial copy, but its value reads back
    // malformed/undefined on this resumed-migration boot (a transient read). The
    // copy loop must skip it by KEY PRESENCE (getKeys), not re-copy the blob over
    // it; the remaining heater-1 still gets copied.
    store.set(keyFor('ev-1'), { busted: true }); // present in getKeys, normalizes to undefined
    migrateBlobToPerKeyIfNeeded(store);
    expect(store.get(keyFor('ev-1'))).toEqual({ busted: true }); // NOT overwritten by the blob
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual(tempEntry); // the absent one copied
  });

  it('FRESH INSTALL: non-empty getKeys but no blob → marker set, no entries written', () => {
    const store = new FakeStore();
    store.set('capacity_limit_kw', 5); // a real install always has settings keys
    migrateBlobToPerKeyIfNeeded(store);
    expect(readAllObjectives(store)).toEqual(blob({}));
    expect(store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)).toBe(true);
  });

  it('skips malformed blob entries without aborting the rest', () => {
    const store = new FakeStore();
    // The blob normalizer drops malformed entries, so only ev-1 survives.
    store.set(DEFERRED_OBJECTIVES_SETTINGS, {
      version: 1,
      objectivesByDeviceId: { 'ev-1': evEntry, 'bad': { enabled: 'no' } },
    });
    migrateBlobToPerKeyIfNeeded(store);
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(readObjectiveForDevice(store, 'bad')).toBeUndefined();
  });
});
