import { describe, expect, it, vi } from 'vitest';
import {
  createEvCarLinkRepository,
  createPersistedEvCarLinkAccess,
  importLegacyEvCarLinkState,
} from '../../lib/device/evCarLinkStore';
import {
  clearEvCarObservedStops,
  createEmptyEvCarLinkSnapshot,
  EV_CAR_LINK_PRUNE_MAX_AGE_MS,
  EV_CAR_LINK_VERSION,
  recordEvCarLinkSession,
  recordEvCarLinkVote,
  recordEvCarSelfStopSoc,
  resolveEvCarChargeLimit,
} from '../../lib/device/evCarLinkSnapshot';
import { createEvCarLinkProducer } from '../../lib/device/evCarLinkWiring';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { EV_CAR_LINK_STATE } from '../../lib/utils/settingsKeys';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import { captureLogger } from '../utils/loggerCapture';
import { MockSettings } from '../mocks/homey';

const NOW = 10 * EV_CAR_LINK_PRUNE_MAX_AGE_MS;

const HISTORY: EvCarLinkSnapshot = {
  version: EV_CAR_LINK_VERSION,
  pairs: { 'car|charger': { votes: 5, lastVotedAtMs: NOW - 1_000 } },
  cars: { car: { stopSocPct: [80, 80], lastObservedAtMs: NOW - 1_000 } },
  sessions: { charger: { carId: 'car', sinceMs: NOW - 2_000 } },
};

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, repository: createEvCarLinkRepository(db) };
};

const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('evCarLinkStore', () => {
  it('answers null while empty, and round-trips a snapshot', () => {
    const { repository } = open();
    expect(repository.read(NOW)).toBeNull();
    repository.write(HISTORY);
    expect(repository.read(NOW)).toEqual(HISTORY);
  });

  it('a vote rewrites the pairs and nothing else', () => {
    const { db, repository } = open();
    const access = createPersistedEvCarLinkAccess(repository, NOW, true);
    access.set(HISTORY);
    const before = totalChanges(db);
    access.set(recordEvCarLinkVote(access.get(), 'car', 'charger', NOW));
    expect(totalChanges(db) - before).toBe(1);
    expect(repository.read(NOW)?.pairs['car|charger'].votes).toBe(6);
  });

  it('writes every change through, so the next boot reads it', () => {
    const { repository } = open();
    const access = createPersistedEvCarLinkAccess(repository, NOW, true);
    access.set(recordEvCarSelfStopSoc(access.get(), 'car', 80, NOW));
    access.set(recordEvCarLinkSession(access.get(), 'charger', { carId: 'car', sinceMs: NOW }));
    expect(createPersistedEvCarLinkAccess(repository, NOW, true).get()).toEqual(access.get());
  });

  it('prunes records past the retention window on read, keeping sessions', () => {
    // Pair records only accumulate through device churn across restarts, so boot
    // is when stale ones appear. Without this the advertised retention never
    // applies and the store grows with every replaced car or charger.
    const { repository } = open();
    repository.write({
      ...HISTORY,
      pairs: { ...HISTORY.pairs, 'old|charger': { votes: 9, lastVotedAtMs: 1 } },
      cars: { ...HISTORY.cars, old: { stopSocPct: [80], lastObservedAtMs: 1 } },
    });
    expect(repository.read(NOW)).toEqual(HISTORY);
  });

  it('deletes a family row that is not a record, and drops the malformed records of one that is', () => {
    const { db, repository } = open();
    repository.write(HISTORY);
    db.prepare("UPDATE ev_car_link_state SET value_json = '[]' WHERE family = 'cars'").run();
    db.prepare("UPDATE ev_car_link_state SET value_json = ? WHERE family = 'pairs'").run(JSON.stringify({
      ...HISTORY.pairs, 'not-a-pair': { votes: 1, lastVotedAtMs: NOW },
    }));
    expect(repository.read(NOW)).toEqual({ ...HISTORY, cars: {} });
    expect((db.prepare('SELECT COUNT(*) AS n FROM ev_car_link_state').get() as { n: number }).n).toBe(2);
  });

  it('keeps a change whose write failed, and writes it with the next one', () => {
    const { repository } = open();
    const access = createPersistedEvCarLinkAccess(repository, NOW, true);
    const capture = captureLogger();
    const write = vi.spyOn(repository, 'write').mockImplementationOnce(() => { throw new Error('disk full'); });
    try {
      access.set(HISTORY);
      expect(capture.findEvent('ev_car_link_persist_failed')).toBeDefined();
    } finally {
      write.mockRestore();
      capture.restore();
    }
    expect(access.get()).toBe(HISTORY);
    expect(repository.read(NOW)).toBeNull();
    access.set(recordEvCarLinkVote(access.get(), 'car', 'charger', NOW));
    expect(repository.read(NOW)).toEqual(access.get());
  });
});

describe('importLegacyEvCarLinkState', () => {
  const rig = () => {
    const settings = new MockSettings();
    // A real install never has an empty key list here: the boot migrations
    // set their markers first.
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the blob into an empty store and retires the key; a second boot has nothing to do', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
    expect(repository.read(NOW)).toEqual(HISTORY);
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
    const get = vi.spyOn(settings, 'get');
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  // An empty snapshot standing in for an unread one must not read as "this car
  // never matched": the settings UI would tell the owner to clear a car
  // selection that may have matched many times.
  it('reports the history unresolved while a suspect read leaves the blob for the next boot', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === EV_CAR_LINK_STATE ? undefined : originalGet(key)));
    const historyResolved = importLegacyEvCarLinkState(settings, repository, NOW);
    get.mockRestore();
    expect(historyResolved).toBe(false);
    const producer = createEvCarLinkProducer(
      () => {}, () => [], createPersistedEvCarLinkAccess(repository, NOW, historyResolved), undefined, undefined,
    );
    expect(producer.readChargerMatchesForCar('car')).toEqual({ state: 'unavailable' });
    // A blob with no snapshot in it holds no history to wait for.
    settings.set(EV_CAR_LINK_STATE, 'garbage');
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
  });

  it('reports the history unresolved when the settings key list cannot be read', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('sdk unavailable'); });
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(false);
    expect(settings.get(EV_CAR_LINK_STATE)).toEqual(HISTORY);
  });

  it('imports a version-1 blob without the stop samples it banked under the unsound rule', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, { ...HISTORY, version: 1 });
    importLegacyEvCarLinkState(settings, repository, NOW);
    expect(repository.read(NOW)).toEqual({ ...HISTORY, cars: {} });
  });

  // A boot whose import deferred still lets the probe vote; the next boot's
  // import keeps both, the store's records winning where both have one, and
  // never brings back a session the store may have seen end, or the stops of
  // a car the store has linked since.
  it('imports the blob under what the store already holds', () => {
    const { settings, repository } = rig();
    repository.write({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: NOW } },
      cars: {},
      sessions: {},
    });
    const guest = { stopSocPct: [70, 70], lastObservedAtMs: NOW - 3_000 };
    settings.set(EV_CAR_LINK_STATE, {
      ...HISTORY,
      pairs: { ...HISTORY.pairs, 'guest|other': { votes: 2, lastVotedAtMs: NOW - 3_000 } },
      cars: { ...HISTORY.cars, guest },
    });
    importLegacyEvCarLinkState(settings, repository, NOW);
    expect(repository.read(NOW)).toEqual({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: NOW }, 'guest|other': { votes: 2, lastVotedAtMs: NOW - 3_000 } },
      cars: { guest },
      sessions: {},
    });
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
  });

  // The deferred boot linked the car, learned its limit and saw it charge past
  // it, which clears the car's stops. The blob's older stops agree on the same
  // limit: refilling them would qualify the disproven limit again.
  it('never refills the stops of a car the store linked while the import was deferred', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === EV_CAR_LINK_STATE ? undefined : originalGet(key)));
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(false);
    get.mockRestore();
    const access = createPersistedEvCarLinkAccess(repository, NOW, false);
    access.set(recordEvCarLinkVote(access.get(), 'car', 'charger', NOW));
    access.set(recordEvCarSelfStopSoc(access.get(), 'car', 80, NOW));
    access.set(recordEvCarSelfStopSoc(access.get(), 'car', 80, NOW));
    expect(resolveEvCarChargeLimit(access.get(), 'car')).toBe(80);
    access.set(clearEvCarObservedStops(access.get(), 'car'));

    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
    const merged = repository.read(NOW) ?? createEmptyEvCarLinkSnapshot();
    expect(merged.cars).toEqual({});
    expect(resolveEvCarChargeLimit(merged, 'car')).toBeNull();
  });

  // A disproven limit clears the car's stops (`evCarLinkSelfStop.ts`). Merging
  // the blob again on the next boot would bring them back; the import's mark
  // retires the key instead.
  it('retires the key of an import whose unset threw, so a limit disproven since stays gone', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    const unset = vi.spyOn(settings, 'unset').mockImplementationOnce(() => { throw new Error('sdk unavailable'); });
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
    unset.mockRestore();
    expect(settings.get(EV_CAR_LINK_STATE)).toEqual(HISTORY);
    const access = createPersistedEvCarLinkAccess(repository, NOW, true);
    expect(resolveEvCarChargeLimit(access.get(), 'car')).toBe(80);
    access.set(clearEvCarObservedStops(access.get(), 'car'));

    const capture = captureLogger();
    try {
      expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
      expect(capture.findEvent('legacy_ev_car_link_state_key_retired')).toMatchObject({ reason: 'store_already_holds' });
      expect(capture.findEvent('legacy_ev_car_link_state_imported')).toBeUndefined();
    } finally {
      capture.restore();
    }
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
    const reloaded = createPersistedEvCarLinkAccess(repository, NOW, true).get();
    expect(reloaded.cars).toEqual({});
    expect(resolveEvCarChargeLimit(reloaded, 'car')).toBeNull();
  });

  // An empty key list is the SDK's flake, not an install without the blob: the
  // store may not hold the history yet, so a car must not read as never
  // matched. Once an import has completed, the store holds it either way.
  it('reports the history unresolved when the key list comes back empty, until an import completed', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    const keys = vi.spyOn(settings, 'getKeys').mockReturnValue([]);
    const historyResolved = importLegacyEvCarLinkState(settings, repository, NOW);
    keys.mockRestore();
    expect(historyResolved).toBe(false);
    expect(settings.get(EV_CAR_LINK_STATE)).toEqual(HISTORY);
    const producer = createEvCarLinkProducer(
      () => {}, () => [], createPersistedEvCarLinkAccess(repository, NOW, historyResolved), undefined, undefined,
    );
    expect(producer.readChargerMatchesForCar('car')).toEqual({ state: 'unavailable' });

    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
    vi.spyOn(settings, 'getKeys').mockReturnValue([]);
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
  });

  // A blob whose every entry is malformed is a failed read, not an empty
  // snapshot: importing it would unset the key with nothing taken.
  it('keeps the key of a blob whose every entry is malformed', () => {
    const { settings, repository } = rig();
    const malformed = {
      version: EV_CAR_LINK_VERSION,
      pairs: { 'not-a-pair': { votes: 1, lastVotedAtMs: NOW }, 'car|charger': { votes: 'five' } },
      cars: { car: { stopSocPct: 'eighty', lastObservedAtMs: NOW } },
      sessions: { charger: { carId: '', sinceMs: NOW } },
    };
    settings.set(EV_CAR_LINK_STATE, malformed);
    expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
    expect(settings.get(EV_CAR_LINK_STATE)).toEqual(malformed);
    expect(repository.read(NOW)).toBeNull();
  });

  // Nothing malformed in either: an empty snapshot is one, and a version-1
  // blob's stops are dropped by rule.
  it('imports an empty blob, and a version-1 blob holding only stops', () => {
    for (const blob of [
      { version: EV_CAR_LINK_VERSION, pairs: {}, cars: {}, sessions: {} },
      { version: 1, pairs: {}, cars: HISTORY.cars },
    ]) {
      const { settings, repository } = rig();
      settings.set(EV_CAR_LINK_STATE, blob);
      expect(importLegacyEvCarLinkState(settings, repository, NOW)).toBe(true);
      expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
      expect(repository.read(NOW)).toEqual(createEmptyEvCarLinkSnapshot());
      expect(repository.hasImportedLegacy()).toBe(true);
    }
  });

  // One transient must never cost the probe's evidence: a suspect read leaves
  // the key where it is for the next boot.
  it('defers on a suspect read, a value with no snapshot in it, or a store that cannot answer', () => {
    const { settings, repository } = rig();
    settings.set(EV_CAR_LINK_STATE, { version: 99, pairs: {}, cars: {} });
    importLegacyEvCarLinkState(settings, repository, NOW);
    expect(settings.get(EV_CAR_LINK_STATE)).toEqual({ version: 99, pairs: {}, cars: {} });
    settings.set(EV_CAR_LINK_STATE, HISTORY);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === EV_CAR_LINK_STATE ? undefined : originalGet(key)));
    importLegacyEvCarLinkState(settings, repository, NOW);
    get.mockRestore();
    const write = vi.spyOn(repository, 'writeLegacyImport').mockImplementation(() => { throw new Error('disk full'); });
    importLegacyEvCarLinkState(settings, repository, NOW);
    write.mockRestore();
    expect(repository.read(NOW)).toBeNull();
    expect(originalGet(EV_CAR_LINK_STATE)).toEqual(HISTORY);
    importLegacyEvCarLinkState(settings, repository, NOW);
    expect(repository.read(NOW)).toEqual(HISTORY);
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
  });
});
