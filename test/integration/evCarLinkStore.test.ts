import { describe, expect, it, vi } from 'vitest';
import { loadEvCarLinkStore } from '../../lib/device/evCarLinkStore';
import {
  EV_CAR_LINK_PRUNE_MAX_AGE_MS,
  EV_CAR_LINK_VERSION,
  recordEvCarLinkVote,
} from '../../lib/device/evCarLinkSnapshot';
import { EV_CAR_LINK_STATE, EV_CAR_LINK_STATE_INITIALIZED } from '../../lib/utils/settingsKeys';
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
