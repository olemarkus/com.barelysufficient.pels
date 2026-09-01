import { describe, expect, it, vi } from 'vitest';
import {
  createExternalOffHoldPolicy,
  migrateExternalOffHoldsToPerKey,
  type ExternalOffHoldOptInRead,
  type ExternalOffHoldSettingsStore,
} from '../../lib/observer/externalOffHold';
import { createExternalOffHoldPolicy as createSettingsExternalOffHoldPolicy } from '../../setup/externalOffHoldAdapter';
import {
  EXTERNAL_OFF_HOLDS,
  EXTERNAL_OFF_HOLDS_INITIALIZED,
  EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED,
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';

// Unit tier: the policy is a pure function of its injected store and opt-in
// read — no SDK, no real clock.
//
// A hold is one settings key whose PRESENCE is the fact, so the rules worth
// pinning are about the KEY LIST, not about a stored value: an unreadable list
// must never answer "not held", an empty list is a flake rather than an empty
// store, and a release must land whatever the list said. The blob-era rules
// (junk-tolerant value parsing, dirty-gated writes, abandon-grace, tombstoned
// releases) are gone with the blob — their whole job was to stop one
// full-replacing write from wiping every other device's hold, and a per-key
// write cannot reach another device.

const holdKey = (deviceId: string): string => (
  `${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${deviceId}`
);

const optedIn = (optIn: Record<string, boolean>): ExternalOffHoldOptInRead => (
  { status: 'resolved', optIn }
);

type FakeStore = ExternalOffHoldSettingsStore & {
  backing: Map<string, unknown>;
  failKeys: { current: boolean };
};

/**
 * Stands in for the rest of PELS's settings. Seeded into every fake store,
 * because it is load-bearing rather than scenery: an empty `getKeys()` is read
 * as a transient-store flake by design, so a fixture holding nothing but the
 * hold under test would flip to fail-closed the moment that hold is released —
 * and a lost-release bug would read as a pass. A real install always carries
 * other keys. The one test that WANTS an empty list builds its own bare store.
 */
const OTHER_SETTINGS_KEY = 'some_other_pels_setting';

/**
 * An in-memory stand-in for `homey.settings`. Mirrors the real manager where it
 * matters: an unset key reads `null` (not `undefined`), and `getKeys` is derived
 * from the backing map so writes and unsets stay consistent with it.
 */
const fakeStore = (seed: Record<string, unknown> = {}): FakeStore => {
  const backing = new Map<string, unknown>([[OTHER_SETTINGS_KEY, 1], ...Object.entries(seed)]);
  const failKeys = { current: false };
  return {
    backing,
    failKeys,
    get: (key) => (backing.has(key) ? backing.get(key) : null),
    set: (key, value) => { backing.set(key, value); },
    unset: (key) => { backing.delete(key); },
    getKeys: () => {
      if (failKeys.current) throw new Error('settings unavailable');
      return Array.from(backing.keys());
    },
  };
};

const build = (
  store: ExternalOffHoldSettingsStore,
  readOptIn: () => ExternalOffHoldOptInRead = () => optedIn({ a: true, b: true }),
) => createExternalOffHoldPolicy({ store, readOptIn });

describe('external-off hold policy — a hold is a key', () => {
  it('reports a hold seeded by a previous run, with no value read', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    const get = vi.spyOn(store, 'get');
    expect(build(store).isHeld('a')).toBe(true);
    // The key's presence is the whole fact; reading its value would be reading
    // something nothing writes meaningfully.
    expect(get).not.toHaveBeenCalledWith(holdKey('a'));
  });

  it('starts a hold, and reports a duplicate start as a no-op', () => {
    const store = fakeStore();
    const policy = build(store);
    expect(policy.startHold('a')).toBe(true);
    expect(store.backing.get(holdKey('a'))).toBe(true);
    expect(policy.startHold('a')).toBe(false);
  });

  it('clears only a hold that was actually present', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    const policy = build(store);
    expect(policy.clearHold('a')).toBe(true);
    expect(store.backing.has(holdKey('a'))).toBe(false);
    expect(policy.clearHold('a')).toBe(false);
  });

  it('one device is unaffected by another device being held or released', () => {
    const store = fakeStore();
    const policy = build(store);
    policy.startHold('a');
    policy.startHold('b');
    policy.clearHold('a');
    expect(policy.isHeld('a')).toBe(false);
    expect(policy.isHeld('b')).toBe(true);
  });

  it('enumerates an id that round-trips back to the key it came from', () => {
    // `dropDeOptedHolds` feeds these ids straight to `clearHold`, which rebuilds
    // the key with `perDeviceKey`. Normalising the id here (trimming, say) would
    // rebuild a key that is not the one on disk and the unset would miss, so a
    // de-opted hold could never be released.
    const oddId = ' spacey ';
    const store = fakeStore({ [holdKey(oddId)]: true });
    const policy = build(store, () => optedIn({}));
    // The constructor's de-opt sweep already had to hit the real key.
    expect(store.backing.has(holdKey(oddId))).toBe(false);
    expect(policy.heldDeviceIds()).toEqual([]);
  });

  it('ignores the bare prefix with no device id after it', () => {
    const store = fakeStore({ [PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX]: true });
    expect(build(store).heldDeviceIds()).toEqual([]);
  });

  it('enumerates held devices without matching the legacy blob key', () => {
    // `external_off_holds` must not be mistaken for a per-device key: the prefix
    // ends in a dot and the blob key does not carry one.
    const store = fakeStore({
      [EXTERNAL_OFF_HOLDS]: { version: 1, entriesByDeviceId: {} },
      [holdKey('a')]: true,
    });
    expect(build(store).heldDeviceIds()).toEqual(['a']);
  });
});

describe('external-off hold policy — an unreadable key list is not an empty one', () => {
  it('keeps an opted-in device held while the key list cannot be read', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    const policy = build(store);
    store.failKeys.current = true;
    // Answering "not held" here IS the resume this feature exists to prevent.
    expect(policy.isHeld('a')).toBe(true);
  });

  it('fails closed for EVERY device while both reads are unavailable', () => {
    const store = fakeStore();
    const policy = build(store, () => ({ status: 'unavailable' }));
    store.failKeys.current = true;
    // The opt-in map cannot rule any device out either, so none is ruled out.
    expect(policy.isHeld('never-seen')).toBe(true);
  });

  it('treats an EMPTY key list as a flake, not an empty store', () => {
    // PELS always has settings keys, so an empty list means the read is bad.
    // Deliberately bare — this is the one fixture that must hold nothing.
    const bare: ExternalOffHoldSettingsStore = {
      get: () => null,
      set: () => {},
      unset: () => {},
      getKeys: () => [],
    };
    expect(build(bare).isHeld('a')).toBe(true);
    expect(build(bare).heldDeviceIds()).toEqual([]);
  });

  it('records a genuine transition rather than trusting the fail-closed guess', () => {
    // The guess is not a hold. If a real outside-off arrives while the list is
    // unreadable, it has to be written — otherwise the guess evaporates when the
    // read recovers and the device is resumed.
    const store = fakeStore();
    const policy = build(store);
    store.failKeys.current = true;
    expect(policy.startHold('a')).toBe(true);
    store.failKeys.current = false;
    expect(policy.heldDeviceIds()).toEqual(['a']);
  });

  it('lands a release on the store even though nothing could be enumerated', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    const policy = build(store);
    store.failKeys.current = true;
    policy.clearHold('a');
    store.failKeys.current = false;
    // No tombstone, no pending write, no reconcile: the unset already happened.
    expect(policy.isHeld('a')).toBe(false);
  });

  it('survives a getKeys that answers a non-array', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    const malformed = { ...store, getKeys: () => (undefined as unknown as string[]) };
    expect(build(malformed).isHeld('a')).toBe(true);
    expect(build(malformed).heldDeviceIds()).toEqual([]);
  });
});

describe('external-off hold policy — opt-in reconciliation', () => {
  it('drops a hold whose opt-in was cleared while the app was down', () => {
    const store = fakeStore({ [holdKey('a')]: true, [holdKey('b')]: true });
    build(store, () => optedIn({ b: true }));
    // Reconciled by the constructor — nothing else compares the two keys.
    expect(store.backing.has(holdKey('a'))).toBe(false);
    expect(store.backing.has(holdKey('b'))).toBe(true);
  });

  it('does not release stored holds when the opt-in map cannot be read', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    build(store, () => ({ status: 'unavailable' }));
    expect(store.backing.has(holdKey('a'))).toBe(true);
  });

  it('reconciles the opt-out as soon as the map does resolve', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    let read: ExternalOffHoldOptInRead = { status: 'unavailable' };
    const policy = build(store, () => read);
    expect(policy.heldDeviceIds()).toEqual(['a']);
    read = optedIn({});
    expect(policy.releaseDeOptedHolds()).toEqual(['a']);
    expect(store.backing.has(holdKey('a'))).toBe(false);
  });

  it('retries a de-opt on the plan-cycle sweep, not only on the settings edge', () => {
    const store = fakeStore({ [holdKey('a')]: true });
    let read: ExternalOffHoldOptInRead = { status: 'unavailable' };
    const policy = build(store, () => read);
    read = optedIn({});
    // `heldDeviceIds` is the pull-path sweep; it reconciles before answering.
    expect(policy.heldDeviceIds()).toEqual([]);
  });

  it('reads the opt-in live so a just-toggled device takes effect', () => {
    const store = fakeStore();
    let read = optedIn({});
    const policy = build(store, () => read);
    expect(policy.isEnabledForDevice('a')).toBe(false);
    read = optedIn({ a: true });
    expect(policy.isEnabledForDevice('a')).toBe(true);
  });
});

describe('external-off hold — blob to per-key migration', () => {
  const blob = (deviceIds: string[]): unknown => ({
    version: 1,
    entriesByDeviceId: Object.fromEntries(deviceIds.map((id) => [id, { sinceMs: 500 }])),
  });

  it('copies each held device to its own key, then consumes the blob', () => {
    const store = fakeStore({
      [EXTERNAL_OFF_HOLDS]: blob(['a', 'b']),
      [EXTERNAL_OFF_HOLDS_INITIALIZED]: true,
    });
    migrateExternalOffHoldsToPerKey(store);
    expect(store.backing.get(holdKey('a'))).toBe(true);
    expect(store.backing.get(holdKey('b'))).toBe(true);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(false);
    // Dead with the blob it described.
    expect(store.backing.has(EXTERNAL_OFF_HOLDS_INITIALIZED)).toBe(false);
    expect(store.backing.get(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(true);
  });

  it('is a no-op once the marker is set', () => {
    const store = fakeStore({
      [EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED]: true,
      [EXTERNAL_OFF_HOLDS]: blob(['a']),
    });
    migrateExternalOffHoldsToPerKey(store);
    // The blob is left exactly as found — a second pass must not re-consume it.
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(true);
    expect(store.backing.has(holdKey('a'))).toBe(false);
  });

  it('refuses to mark migrated against an unreadable key list', () => {
    const store = fakeStore({ [EXTERNAL_OFF_HOLDS]: blob(['a']) });
    store.failKeys.current = true;
    migrateExternalOffHoldsToPerKey(store);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(false);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(true);
  });

  it('refuses to consume a blob whose value reads back malformed', () => {
    // A present key whose value flakes is not an empty blob. Consuming here
    // would erase the only copy of the user's holds.
    const store = fakeStore({ [EXTERNAL_OFF_HOLDS]: undefined });
    migrateExternalOffHoldsToPerKey(store);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(true);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(false);
  });

  it('marks migrated with no blob present, and never resurrects a cleared hold', () => {
    // A completed migration whose marker-set flaked lands here on the next boot.
    // The blob is gone, so there is no source to copy from — the device the user
    // released after migrating must not reappear.
    const store = fakeStore();
    migrateExternalOffHoldsToPerKey(store);
    expect(store.backing.get(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(true);
    expect(store.backing.has(holdKey('a'))).toBe(false);
  });

  it('resumes a partial copy without clobbering an already-copied key', () => {
    // A prior boot crashed mid-copy: 'a' landed, the blob was not consumed.
    const store = fakeStore({
      [EXTERNAL_OFF_HOLDS]: blob(['a', 'b']),
      [holdKey('a')]: true,
    });
    const set = vi.spyOn(store, 'set');
    migrateExternalOffHoldsToPerKey(store);
    expect(set).not.toHaveBeenCalledWith(holdKey('a'), expect.anything());
    expect(store.backing.get(holdKey('b'))).toBe(true);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(false);
  });

  it('skips a blob entry the v1 loader would have skipped, and migrates the rest', () => {
    // The old loader required a finite positive `sinceMs` per entry and dropped
    // the ones that failed. A migration reproduces what the old code would have
    // loaded — no more (do not invent a hold from a corrupt entry) and no less
    // (do not refuse the whole blob, which would stall the migration forever
    // and re-run it every boot).
    const store = fakeStore({
      [EXTERNAL_OFF_HOLDS]: {
        version: 1,
        entriesByDeviceId: {
          good: { sinceMs: 500 },
          missing: {},
          nan: { sinceMs: Number.NaN },
          negative: { sinceMs: -1 },
          notAnObject: 'nope',
        },
      },
    });
    migrateExternalOffHoldsToPerKey(store);
    expect(store.backing.get(holdKey('good'))).toBe(true);
    for (const id of ['missing', 'nan', 'negative', 'notAnObject']) {
      expect(store.backing.has(holdKey(id))).toBe(false);
    }
    // Consumed, so the migration completes rather than retrying every boot.
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(false);
    expect(store.backing.get(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(true);
  });

  it('migrates a genuinely empty blob rather than stalling forever', () => {
    const store = fakeStore({ [EXTERNAL_OFF_HOLDS]: blob([]) });
    migrateExternalOffHoldsToPerKey(store);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(false);
    expect(store.backing.get(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(true);
  });

  it('leaves the blob for the next boot when a copy write throws', () => {
    const store = fakeStore({ [EXTERNAL_OFF_HOLDS]: blob(['a']) });
    const throwing: ExternalOffHoldSettingsStore = {
      ...store,
      set: (key) => { if (key === holdKey('a')) throw new Error('nope'); },
    };
    migrateExternalOffHoldsToPerKey(throwing);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(true);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED)).toBe(false);
  });

  it('hands a migrated hold to the policy', () => {
    const store = fakeStore({ [EXTERNAL_OFF_HOLDS]: blob(['a']) });
    migrateExternalOffHoldsToPerKey(store);
    expect(build(store).isHeld('a')).toBe(true);
  });
});

describe('external-off hold — the store must be migrated before it can be read', () => {
  it('answers a legacy hold even when the boot migration deferred', () => {
    // The migration returns silently when the marker read fails. A policy that
    // then read only per-device keys would report an upgrading owner's hold as
    // absent for the rest of the boot, and the next plan would resume the
    // device they left off.
    const store = fakeStore({
      [EXTERNAL_OFF_HOLDS]: { version: 1, entriesByDeviceId: { a: { sinceMs: 500 } } },
    });
    const failingMarker = { current: true };
    const flaky: ExternalOffHoldSettingsStore = {
      ...store,
      get: (key) => {
        if (failingMarker.current && key === EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED) {
          throw new Error('settings unavailable');
        }
        return store.get(key);
      },
    };
    const policy = build(flaky);
    // Boot-time migration deferred, so nothing was copied yet.
    expect(store.backing.has(holdKey('a'))).toBe(false);
    // The SDK recovers mid-boot: the next read heals it rather than waiting for
    // a restart.
    failingMarker.current = false;
    expect(policy.isHeld('a')).toBe(true);
    expect(store.backing.has(EXTERNAL_OFF_HOLDS)).toBe(false);
  });
});

describe('external-off hold — a start write is the one that cannot be retried later', () => {
  it('retries a transiently throwing write instead of losing the hold', () => {
    // A hold starts on a one-shot ON->OFF edge; nothing re-derives it, so a
    // dropped write loses it for good.
    const store = fakeStore();
    let throwsLeft = 2;
    const flaky: ExternalOffHoldSettingsStore = {
      ...store,
      set: (key, value) => {
        if (key === holdKey('a') && throwsLeft > 0) {
          throwsLeft -= 1;
          throw new Error('settings unavailable');
        }
        store.set(key, value);
      },
    };
    expect(build(flaky).startHold('a')).toBe(true);
    expect(store.backing.get(holdKey('a'))).toBe(true);
  });

  it('reports a write that never succeeds as a failure rather than claiming a hold', () => {
    const store = fakeStore();
    const throwing: ExternalOffHoldSettingsStore = {
      ...store,
      set: (key, value) => {
        if (key === holdKey('a')) throw new Error('settings unavailable');
        store.set(key, value);
      },
    };
    expect(build(throwing).startHold('a')).toBe(false);
    expect(store.backing.has(holdKey('a'))).toBe(false);
  });
});

describe('external-off hold settings adapter — a flaky store', () => {
  it('does not treat an unreadable opt-in map as an empty one', () => {
    // `{}` at startup would make every stored hold look de-opted, and the
    // policy's constructor would clear them all.
    const backing = new Map<string, unknown>([[holdKey('a'), true]]);
    const policy = createSettingsExternalOffHoldPolicy({
      get: (key) => {
        if (key === RESPECT_EXTERNAL_OFF_DEVICES) throw new Error('settings unavailable');
        return backing.has(key) ? backing.get(key) : null;
      },
      set: (key, value) => { backing.set(key, value); },
      unset: (key) => { backing.delete(key); },
      getKeys: () => Array.from(backing.keys()),
    });
    expect(backing.has(holdKey('a'))).toBe(true);
    expect(policy.isHeld('a')).toBe(true);
  });

  it('reads an absent opt-in map as a genuine "nobody opted in"', () => {
    // Absence is a real answer here: clearing the setting must be able to turn
    // the feature off, so it releases rather than failing closed.
    const backing = new Map<string, unknown>([[holdKey('a'), true]]);
    createSettingsExternalOffHoldPolicy({
      get: (key) => (backing.has(key) ? backing.get(key) : null),
      set: (key, value) => { backing.set(key, value); },
      unset: (key) => { backing.delete(key); },
      getKeys: () => Array.from(backing.keys()),
    });
    expect(backing.has(holdKey('a'))).toBe(false);
  });

  it('falls back to the last good map when a later read goes malformed', () => {
    const backing = new Map<string, unknown>([
      [RESPECT_EXTERNAL_OFF_DEVICES, { a: true }],
      [holdKey('a'), true],
    ]);
    const policy = createSettingsExternalOffHoldPolicy({
      get: (key) => (backing.has(key) ? backing.get(key) : null),
      set: (key, value) => { backing.set(key, value); },
      unset: (key) => { backing.delete(key); },
      getKeys: () => Array.from(backing.keys()),
    });
    expect(policy.isEnabledForDevice('a')).toBe(true);
    backing.set(RESPECT_EXTERNAL_OFF_DEVICES, 'garbage');
    expect(policy.isEnabledForDevice('a')).toBe(true);
    expect(backing.has(holdKey('a'))).toBe(true);
  });
});
