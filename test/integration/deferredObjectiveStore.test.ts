import {
  afterEach, describe, expect, it, vi,
} from 'vitest';
import {
  clearObjectiveForDevice,
  createTrustedDeferredObjectiveSettingsReader,
  readAllObjectives,
  readDeferredObjectiveRoster,
  readObjectiveForDevice,
  writeObjectiveForDevice,
  type ObjectiveSettingsStore,
} from '../../lib/objectives/deferredObjectives/objectiveStore';
import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveRoster,
} from '../../packages/contracts/src/deferredObjectiveSettings';

const DEADLINE_MS = Date.UTC(2026, 0, 1, 18, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

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
// A `failKeys` toggle makes the key-list read throw.
class FakeStore implements ObjectiveSettingsStore {
  readonly map = new Map<string, unknown>();
  failKeys = false;

  get(key: string): unknown { return this.map.get(key); }
  set(key: string, value: unknown): void { this.map.set(key, value); }
  unset(key: string): void { this.map.delete(key); }
  getKeys(): string[] {
    if (this.failKeys) throw new Error('SDK read failed');
    return [...this.map.keys()];
  }
}

const roster = (
  entries: Record<string, DeferredObjectiveSettingsEntry>,
): DeferredObjectiveRoster => ({ objectivesByDeviceId: entries });

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

  it('readAll assembles the roster from per-device keys', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    writeObjectiveForDevice(store, 'heater-1', tempEntry);
    expect(readAllObjectives(store)).toEqual(roster({ 'ev-1': evEntry, 'heater-1': tempEntry }));
  });

  it('readAll skips malformed entries and foreign (non-prefixed) keys', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    store.set(keyFor('bad-1'), { enabled: 'nope' }); // malformed → skipped
    store.set('capacity_limit_kw', 5); // foreign key → not matched by prefix
    expect(readAllObjectives(store)).toEqual(roster({ 'ev-1': evEntry }));
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
});

describe('readDeferredObjectiveRoster', () => {
  it('resolves from the per-device keys alone, whatever else the settings hold', () => {
    // An outside writer once stored a roster under the retired plural key; the
    // reader must neither surface it nor go unavailable over it.
    const store = new FakeStore();
    store.set('capacity_limit_kw', 5);
    store.set('deferred_objectives', roster({ ghost: tempEntry }));
    writeObjectiveForDevice(store, 'ev-1', evEntry);

    expect(readDeferredObjectiveRoster(store)).toEqual({
      status: 'resolved',
      settings: roster({ 'ev-1': evEntry }),
    });
  });

  it('resolves an empty store to an empty roster', () => {
    // Homey answers a never-written key by leaving it out of `getKeys()`.
    expect(readDeferredObjectiveRoster(new FakeStore())).toEqual({
      status: 'resolved',
      settings: roster({}),
    });
  });

  it.each([
    ['null', null],
    ['a string', 'deferred_objective.ev-1'],
    ['a mixed array', ['capacity_limit_kw', 42]],
  ])('fails closed when getKeys returns %s', (_label, malformedKeys) => {
    const store = new FakeStore();
    Object.defineProperty(store, 'getKeys', { value: () => malformedKeys });

    expect(readDeferredObjectiveRoster(store)).toEqual({ status: 'unavailable' });
  });

  it('fails closed when getKeys throws', () => {
    const store = new FakeStore();
    Object.defineProperty(store, 'getKeys', { value: () => { throw new Error('SDK read failed'); } });

    expect(readDeferredObjectiveRoster(store)).toEqual({ status: 'unavailable' });
  });
});

describe('createTrustedDeferredObjectiveSettingsReader', () => {
  it('retains the last trusted roster when a listed task becomes unreadable', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    const read = createTrustedDeferredObjectiveSettingsReader(store);

    expect(read()).toEqual(roster({ 'ev-1': evEntry }));
    store.set(keyFor('ev-1'), { enabled: 'temporarily-malformed' });
    expect(read()).toEqual(roster({ 'ev-1': evEntry }));
  });

  it('expires an unreadable roster after the abandon-grace window and recovers on a healthy read', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    const read = createTrustedDeferredObjectiveSettingsReader(store);

    expect(read()).toEqual(roster({ 'ev-1': evEntry }));
    vi.setSystemTime(HOUR_MS);
    store.set(keyFor('ev-1'), { enabled: 'persistently-malformed' });
    expect(read()).toBeUndefined();

    const recovered = { ...evEntry, targetPercent: 90 };
    writeObjectiveForDevice(store, 'ev-1', recovered);
    expect(read()).toEqual(roster({ 'ev-1': recovered }));
  });

  it('stays unavailable before the first trusted roster and later recovers', () => {
    const store = new FakeStore();
    writeObjectiveForDevice(store, 'ev-1', evEntry);
    store.failKeys = true;
    const read = createTrustedDeferredObjectiveSettingsReader(store);

    expect(read()).toBeUndefined();
    store.failKeys = false;
    expect(read()).toEqual(roster({ 'ev-1': evEntry }));
  });
});
