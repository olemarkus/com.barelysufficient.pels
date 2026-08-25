import { describe, expect, it, vi } from 'vitest';
import { loadEvCarLinkStore, persistEvCarLinkFlush } from '../../lib/device/evCarLinkStore';
import {
  EV_CAR_LINK_PRUNE_MAX_AGE_MS,
  EV_CAR_LINK_VERSION,
  recordEvCarLinkVote,
} from '../../lib/device/evCarLinkSnapshot';
import { EV_CAR_LINK_STATE, EV_CAR_LINK_STATE_INITIALIZED } from '../../lib/utils/settingsKeys';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyRuntime } from '../../lib/ports/homeyRuntime';

const NOW = 10 * EV_CAR_LINK_PRUNE_MAX_AGE_MS;

const runtime = (initial: Record<string, unknown>): HomeyRuntime => {
  const values = new Map(Object.entries(initial));
  return {
    settings: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => { values.set(key, value); },
      unset: (key: string) => { values.delete(key); },
    },
  };
};

describe('loadEvCarLinkStore', () => {
  it('prunes records past the retention window on load', () => {
    // Pair records only accumulate through device churn across restarts, so boot
    // is when stale ones appear. Without this the advertised retention never
    // applies and the settings blob grows with every replaced car or charger.
    const store = loadEvCarLinkStore({
      homey: runtime({
        [EV_CAR_LINK_STATE]: {
          version: EV_CAR_LINK_VERSION,
          pairs: {
            'old|charger': { votes: 9, lastVotedAtMs: 1 },
            'live|charger': { votes: 1, lastVotedAtMs: NOW - 1_000 },
          },
          cars: { old: { stopSocPct: [80], lastObservedAtMs: 1 } },
        },
        [EV_CAR_LINK_STATE_INITIALIZED]: true,
      }),
      options: { nowMs: NOW },
    });
    expect(Object.keys(store.getSnapshot().pairs)).toEqual(['live|charger']);
    expect(store.getSnapshot().cars).toEqual({});
  });

  it('engages the load grace when a persisted stop array is only partly valid', () => {
    // `normalizeObservedStops` FILTERS bad samples and still succeeds, so a mixed
    // array used to pass the plausibility gate: no grace, and the next accepted
    // vote persisted the lossy normalized value over recoverable history.
    const store = loadEvCarLinkStore({
      homey: runtime({
        [EV_CAR_LINK_STATE]: {
          version: EV_CAR_LINK_VERSION,
          pairs: {},
          cars: { 'car-1': { stopSocPct: [80, null], lastObservedAtMs: NOW - 1_000 } },
        },
        [EV_CAR_LINK_STATE_INITIALIZED]: true,
      }),
      options: { nowMs: NOW },
    });

    store.setSnapshot({ ...store.getSnapshot(), pairs: { 'car-1|charger-1': { votes: 1, lastVotedAtMs: NOW } } });
    // Inside the grace nothing may be written over the partially-readable value.
    expect(store.snapshotForFlush(NOW)).toBeNull();
    expect(store.snapshotForPersist(NOW)).toBeNull();
  });

  it('loads a plausible snapshot and persists a later change immediately', () => {
    const store = loadEvCarLinkStore({
      homey: runtime({
        [EV_CAR_LINK_STATE]: {
          version: EV_CAR_LINK_VERSION,
          pairs: { 'car|charger': { votes: 3, lastVotedAtMs: NOW - 1_000 } },
          cars: {},
        },
        [EV_CAR_LINK_STATE_INITIALIZED]: true,
      }),
      options: { nowMs: NOW },
    });
    // The loaded snapshot is the persisted one, not an empty rebuild.
    expect(store.getSnapshot().pairs['car|charger'].votes).toBe(3);
    // Nothing dirty yet, so nothing to flush.
    expect(store.snapshotForFlush(NOW)).toBeNull();
    // A plausible read engages NO load grace, so the first change is immediately
    // flushable — that is the behaviour this test exists to pin.
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    expect(store.snapshotForFlush(NOW)).not.toBeNull();
    expect(store.getSnapshot().pairs['car|charger'].votes).toBe(4);
  });

  it('engages the load grace when a prior install reads back empty', () => {
    // Marker present but no snapshot = transient settings miss, not a fresh
    // install. Persisting immediately would overwrite recoverable history.
    const store = loadEvCarLinkStore({
      homey: runtime({ [EV_CAR_LINK_STATE_INITIALIZED]: true }),
      options: { nowMs: NOW },
    });
    store.setSnapshot({ version: EV_CAR_LINK_VERSION, pairs: {}, cars: {} });
    expect(store.snapshotForFlush(NOW)).toBeNull();
  });

  it('writes immediately on a genuine fresh install', () => {
    const store = loadEvCarLinkStore({ homey: runtime({}), options: { nowMs: NOW } });
    store.setSnapshot({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: NOW } },
      cars: {},
    });
    expect(store.snapshotForFlush(NOW)).not.toBeNull();
  });

  it('survives a settings read that throws', () => {
    const throwing: HomeyRuntime = {
      settings: {
        get: vi.fn(() => { throw new Error('sdk unavailable'); }),
        set: vi.fn(),
        unset: vi.fn(),
      },
    };
    const store = loadEvCarLinkStore({ homey: throwing, options: { nowMs: NOW } });
    expect(store.getSnapshot().pairs).toEqual({});
    // A throw must take the cautious branch, never the fresh-install one.
    store.setSnapshot({ version: EV_CAR_LINK_VERSION, pairs: {}, cars: {} });
    expect(store.snapshotForFlush(NOW)).toBeNull();
  });
});

describe('first-write recovery re-read', () => {
  const GRACE_END = NOW + 5 * 60 * 1000;
  const DEFERRAL_END = GRACE_END + 5 * 60 * 1000;
  const historicBlob = {
    version: EV_CAR_LINK_VERSION,
    pairs: { 'other|charger2': { votes: 6, lastVotedAtMs: NOW - 500 } },
    cars: { other: { stopSocPct: [80], lastObservedAtMs: NOW - 500 } },
  };

  it('merges recovered history under the in-memory state on the first post-grace write', () => {
    const homey = runtime({ [EV_CAR_LINK_STATE_INITIALIZED]: true });
    const store = loadEvCarLinkStore({ homey, options: { nowMs: NOW } });
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    // The transiently-missing value reappears before the first write.
    homey.settings.set(EV_CAR_LINK_STATE, historicBlob);
    expect(persistEvCarLinkFlush({ homey, store, nowMs: GRACE_END + 1_000 })).toBe(true);
    const written = homey.settings.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot;
    expect(written.pairs['car|charger'].votes).toBe(1);
    expect(written.pairs['other|charger2'].votes).toBe(6);
    expect(written.cars.other.stopSocPct).toEqual([80]);
  });

  it('arms the transient-miss deadline at the first deferred attempt, then writes past it', () => {
    const homey = runtime({ [EV_CAR_LINK_STATE_INITIALIZED]: true });
    const store = loadEvCarLinkStore({ homey, options: { nowMs: NOW } });
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    // First attempt lands long past boot + grace + window — a boot-anchored
    // deadline would abandon recovery on this SINGLE re-read. It must defer
    // and arm the window instead.
    expect(persistEvCarLinkFlush({ homey, store, nowMs: DEFERRAL_END })).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(homey.settings.get(EV_CAR_LINK_STATE)).toBeUndefined();
    // Once the armed window elapses with the value still absent, the key is
    // genuinely gone; writing destroys nothing.
    expect(persistEvCarLinkFlush({ homey, store, nowMs: DEFERRAL_END + 5 * 60 * 1000 })).toBe(true);
    expect((homey.settings.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot).pairs['car|charger'].votes).toBe(1);
  });

  it('writes through immediately when the re-read finds neither value nor marker (genuine wipe)', () => {
    const phase = { healed: false };
    const values = new Map<string, unknown>();
    const homey: HomeyRuntime = {
      settings: {
        get: (key: string): unknown => {
          if (key === EV_CAR_LINK_STATE && !phase.healed) throw new Error('SDK unavailable');
          return undefined;
        },
        set: (key: string, value: unknown) => { values.set(key, value); },
        unset: (key: string) => { values.delete(key); },
      },
    };
    const store = loadEvCarLinkStore({ homey, options: { nowMs: NOW } });
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    phase.healed = true;
    expect(persistEvCarLinkFlush({ homey, store, nowMs: GRACE_END + 1_000 })).toBe(true);
    expect(values.has(EV_CAR_LINK_STATE)).toBe(true);
  });

  it('gives the transient-miss arm its own full window after a long thrown phase', () => {
    // Regression: with one shared deferral window, a long thrown phase would
    // expire it and the first heal-into-absent read abandoned recovery after
    // zero spaced absent re-reads. Each arm must own its window.
    const phase = { throwing: true };
    const values = new Map<string, unknown>();
    const homey: HomeyRuntime = {
      settings: {
        get: (key: string): unknown => {
          if (key === EV_CAR_LINK_STATE_INITIALIZED) return true;
          if (key === EV_CAR_LINK_STATE && phase.throwing) throw new Error('SDK unavailable');
          return undefined;
        },
        set: (key: string, value: unknown) => { values.set(key, value); },
        unset: (key: string) => { values.delete(key); },
      },
    };
    const store = loadEvCarLinkStore({ homey, options: { nowMs: NOW } });
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    // Thrown deferrals arm the thrown arm's window and keep deferring well
    // past it.
    expect(persistEvCarLinkFlush({ homey, store, nowMs: GRACE_END + 1_000 })).toBe(false);
    expect(persistEvCarLinkFlush({ homey, store, nowMs: GRACE_END + 20 * 60 * 1000 })).toBe(false);
    // The SDK heals into the transiently-absent mode.
    phase.throwing = false;
    const missStart = GRACE_END + 21 * 60 * 1000;
    // The first absent read must DEFER and arm the miss arm's OWN window.
    expect(persistEvCarLinkFlush({ homey, store, nowMs: missStart })).toBe(false);
    expect(values.has(EV_CAR_LINK_STATE)).toBe(false);
    // A spaced absent re-read inside the miss window still defers.
    expect(persistEvCarLinkFlush({ homey, store, nowMs: missStart + 60 * 1000 })).toBe(false);
    expect(values.has(EV_CAR_LINK_STATE)).toBe(false);
    // Only once the miss window elapses does the write go.
    expect(persistEvCarLinkFlush({ homey, store, nowMs: missStart + 5 * 60 * 1000 })).toBe(true);
    expect(values.has(EV_CAR_LINK_STATE)).toBe(true);
  });

  it('defers when the value is absent and the marker read throws at recovery time', () => {
    // An unreadable marker is treated as marker-present; inverting it would
    // let a transient marker-read failure abandon recovery and overwrite
    // live history.
    const phase = { markerThrows: false };
    const values = new Map<string, unknown>();
    const homey: HomeyRuntime = {
      settings: {
        get: (key: string): unknown => {
          if (key === EV_CAR_LINK_STATE_INITIALIZED) {
            if (phase.markerThrows) throw new Error('SDK unavailable');
            return true;
          }
          return undefined;
        },
        set: (key: string, value: unknown) => { values.set(key, value); },
        unset: (key: string) => { values.delete(key); },
      },
    };
    const store = loadEvCarLinkStore({ homey, options: { nowMs: NOW } });
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    phase.markerThrows = true;
    expect(persistEvCarLinkFlush({ homey, store, nowMs: GRACE_END + 1_000 })).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(values.has(EV_CAR_LINK_STATE)).toBe(false);
  });

  it('defers a throwing re-read past any deadline, then merges once the SDK heals', () => {
    let healed = false;
    const values = new Map<string, unknown>();
    const homey: HomeyRuntime = {
      settings: {
        get: (key: string): unknown => {
          if (key === EV_CAR_LINK_STATE_INITIALIZED) return true;
          if (key === EV_CAR_LINK_STATE) {
            if (!healed) throw new Error('SDK unavailable');
            return historicBlob;
          }
          return undefined;
        },
        set: (key: string, value: unknown) => { values.set(key, value); },
        unset: (key: string) => { values.delete(key); },
      },
    };
    const store = loadEvCarLinkStore({ homey, options: { nowMs: NOW } });
    store.setSnapshot(recordEvCarLinkVote({
      snapshot: store.getSnapshot(), carId: 'car', chargerId: 'charger', nowMs: NOW,
    }));
    expect(persistEvCarLinkFlush({ homey, store, nowMs: DEFERRAL_END + 60 * 60 * 1000 })).toBe(false);
    expect(values.has(EV_CAR_LINK_STATE)).toBe(false);
    healed = true;
    expect(persistEvCarLinkFlush({ homey, store, nowMs: DEFERRAL_END + 61 * 60 * 1000 })).toBe(true);
    const written = values.get(EV_CAR_LINK_STATE) as EvCarLinkSnapshot;
    expect(written.pairs['car|charger'].votes).toBe(1);
    expect(written.pairs['other|charger2'].votes).toBe(6);
  });
});
