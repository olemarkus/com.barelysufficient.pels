import { describe, expect, it, vi } from 'vitest';
import {
  createEvCarLinkRepository,
  createPersistedEvCarLinkAccess,
  importLegacyEvCarLinkState,
} from '../../lib/device/evCarLinkStore';
import {
  EV_CAR_LINK_PRUNE_MAX_AGE_MS,
  EV_CAR_LINK_VERSION,
  recordEvCarLinkSession,
  recordEvCarLinkVote,
  recordEvCarSelfStopSoc,
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
  // never brings back a session the store may have seen end.
  it('imports the blob under what the store already holds', () => {
    const { settings, repository } = rig();
    repository.write({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: NOW } },
      cars: {},
      sessions: {},
    });
    settings.set(EV_CAR_LINK_STATE, {
      ...HISTORY,
      pairs: { ...HISTORY.pairs, 'car|other': { votes: 2, lastVotedAtMs: NOW - 3_000 } },
    });
    importLegacyEvCarLinkState(settings, repository, NOW);
    expect(repository.read(NOW)).toEqual({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: NOW }, 'car|other': { votes: 2, lastVotedAtMs: NOW - 3_000 } },
      cars: HISTORY.cars,
      sessions: {},
    });
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
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
    const write = vi.spyOn(repository, 'write').mockImplementation(() => { throw new Error('disk full'); });
    importLegacyEvCarLinkState(settings, repository, NOW);
    write.mockRestore();
    expect(repository.read(NOW)).toBeNull();
    expect(originalGet(EV_CAR_LINK_STATE)).toEqual(HISTORY);
    importLegacyEvCarLinkState(settings, repository, NOW);
    expect(repository.read(NOW)).toEqual(HISTORY);
    expect(settings.get(EV_CAR_LINK_STATE)).toBeNull();
  });
});
