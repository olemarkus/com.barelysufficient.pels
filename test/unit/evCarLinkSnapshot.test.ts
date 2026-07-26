import { describe, expect, it } from 'vitest';
import {
  EV_CAR_LINK_MAX_STOP_SAMPLES,
  EV_CAR_LINK_MAX_TRACKED_CARS,
  EV_CAR_LINK_VERSION,
  buildEvCarLinkPairKey,
  createEmptyEvCarLinkSnapshot,
  getEvCarLinkVotes,
  isStrictlyValidPersistedEvCarLink,
  normalizeEvCarLinkSnapshot,
  parseEvCarLinkPairKey,
  pruneEvCarLinkSnapshot,
  recordEvCarLinkVote,
  recordEvCarSelfStopSoc,
  summarizeEvCarObservedLimit,
} from '../../lib/device/evCarLinkSnapshot';

describe('pair keys', () => {
  it('round-trips', () => {
    expect(parseEvCarLinkPairKey(buildEvCarLinkPairKey('car', 'charger')))
      .toEqual({ carId: 'car', chargerId: 'charger' });
  });

  it('rejects malformed keys rather than half-forming a pair', () => {
    expect(parseEvCarLinkPairKey('car')).toBeNull();
    expect(parseEvCarLinkPairKey('car|charger|extra')).toBeNull();
    expect(parseEvCarLinkPairKey('|charger')).toBeNull();
  });
});

describe('recordEvCarLinkVote', () => {
  it('accumulates votes for a pair', () => {
    const once = recordEvCarLinkVote({
      snapshot: createEmptyEvCarLinkSnapshot(), carId: 'car', chargerId: 'charger', nowMs: 1_000,
    });
    const twice = recordEvCarLinkVote({ snapshot: once, carId: 'car', chargerId: 'charger', nowMs: 2_000 });
    expect(getEvCarLinkVotes(twice, 'car', 'charger')).toBe(2);
    expect(twice.pairs[buildEvCarLinkPairKey('car', 'charger')].lastVotedAtMs).toBe(2_000);
  });

  it('keeps pairs independent', () => {
    const snapshot = recordEvCarLinkVote({
      snapshot: createEmptyEvCarLinkSnapshot(), carId: 'carA', chargerId: 'charger', nowMs: 1,
    });
    expect(getEvCarLinkVotes(snapshot, 'carB', 'charger')).toBe(0);
  });
});

describe('recordEvCarSelfStopSoc', () => {
  it('records in-range samples', () => {
    const snapshot = recordEvCarSelfStopSoc({
      snapshot: createEmptyEvCarLinkSnapshot(), carId: 'car', socPct: 80, nowMs: 5,
    });
    expect(snapshot.cars.car.stopSocPct).toEqual([80]);
  });

  it('drops out-of-range readings instead of clamping them', () => {
    // A clamped 0 or 100 would pollute the cluster the probe exists to read.
    const snapshot = recordEvCarSelfStopSoc({
      snapshot: createEmptyEvCarLinkSnapshot(), carId: 'car', socPct: 140, nowMs: 5,
    });
    expect(snapshot.cars.car).toBeUndefined();
  });

  it('bounds retained samples', () => {
    const snapshot = Array.from({ length: EV_CAR_LINK_MAX_STOP_SAMPLES + 5 })
      .reduce<ReturnType<typeof createEmptyEvCarLinkSnapshot>>(
        (acc, _unused, index) => recordEvCarSelfStopSoc({
          snapshot: acc, carId: 'car', socPct: 50 + (index % 10), nowMs: index + 1,
        }),
        createEmptyEvCarLinkSnapshot(),
      );
    expect(snapshot.cars.car.stopSocPct).toHaveLength(EV_CAR_LINK_MAX_STOP_SAMPLES);
  });

  it('refuses a new car past the tracked-car cap but keeps serving known cars', () => {
    const full = Array.from({ length: EV_CAR_LINK_MAX_TRACKED_CARS })
      .reduce<ReturnType<typeof createEmptyEvCarLinkSnapshot>>(
        (acc, _unused, index) => recordEvCarSelfStopSoc({
          snapshot: acc, carId: `car${index}`, socPct: 80, nowMs: index + 1,
        }),
        createEmptyEvCarLinkSnapshot(),
      );
    const overflowed = recordEvCarSelfStopSoc({ snapshot: full, carId: 'newCar', socPct: 80, nowMs: 99 });
    expect(overflowed.cars.newCar).toBeUndefined();
    const known = recordEvCarSelfStopSoc({ snapshot: overflowed, carId: 'car0', socPct: 81, nowMs: 100 });
    expect(known.cars.car0.stopSocPct).toEqual([80, 81]);
  });
});

describe('summarizeEvCarObservedLimit', () => {
  const withStops = (stops: number[]) => stops.reduce(
    (acc, socPct, index) => recordEvCarSelfStopSoc({ snapshot: acc, carId: 'car', socPct, nowMs: index + 1 }),
    createEmptyEvCarLinkSnapshot(),
  );

  it('returns null below two samples — one stop proves nothing', () => {
    expect(summarizeEvCarObservedLimit(withStops([80]), 'car')).toBeNull();
  });

  it('reports a tight cluster as a candidate charge limit', () => {
    const summary = summarizeEvCarObservedLimit(withStops([80, 80, 79.8, 80.1]), 'car');
    expect(summary).toEqual({ medianPct: 80, spreadPct: 0.3, sampleCount: 4 });
  });

  it('exposes a wide spread so a reader can reject the inference', () => {
    // Unplugged-at-random looks nothing like a charge limit, and the spread is
    // what says so.
    const summary = summarizeEvCarObservedLimit(withStops([42, 91, 63]), 'car');
    expect(summary?.spreadPct).toBe(49);
    expect(summary?.medianPct).toBe(63);
  });
});

describe('normalizeEvCarLinkSnapshot', () => {
  it('degrades unknown shapes to empty rather than throwing', () => {
    expect(normalizeEvCarLinkSnapshot(undefined)).toEqual(createEmptyEvCarLinkSnapshot());
    expect(normalizeEvCarLinkSnapshot('nonsense')).toEqual(createEmptyEvCarLinkSnapshot());
    expect(normalizeEvCarLinkSnapshot([])).toEqual(createEmptyEvCarLinkSnapshot());
  });

  it('rejects a foreign version', () => {
    expect(normalizeEvCarLinkSnapshot({ version: 99, pairs: {}, cars: {} }))
      .toEqual(createEmptyEvCarLinkSnapshot());
  });

  it('drops partial records but keeps valid siblings', () => {
    const normalized = normalizeEvCarLinkSnapshot({
      version: EV_CAR_LINK_VERSION,
      pairs: {
        'car|charger': { votes: 2, lastVotedAtMs: 100 },
        'malformed-key': { votes: 2, lastVotedAtMs: 100 },
        'car2|charger': { votes: 'two', lastVotedAtMs: 100 },
      },
      cars: {
        car: { stopSocPct: [80, 999, 81], lastObservedAtMs: 100 },
        broken: { stopSocPct: 'nope', lastObservedAtMs: 100 },
      },
    });
    expect(Object.keys(normalized.pairs)).toEqual(['car|charger']);
    // The out-of-range sample is dropped, the valid siblings survive.
    expect(normalized.cars.car.stopSocPct).toEqual([80, 81]);
    expect(normalized.cars.broken).toBeUndefined();
  });
});

describe('isStrictlyValidPersistedEvCarLink', () => {
  it('accepts a fully valid snapshot', () => {
    expect(isStrictlyValidPersistedEvCarLink({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: 5 } },
      cars: {},
    })).toBe(true);
  });

  it('rejects an empty snapshot — indistinguishable from a failed read', () => {
    expect(isStrictlyValidPersistedEvCarLink({
      version: EV_CAR_LINK_VERSION, pairs: {}, cars: {},
    })).toBe(false);
  });

  it('rejects any malformed nested record', () => {
    expect(isStrictlyValidPersistedEvCarLink({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 1, lastVotedAtMs: 5 }, bad: { votes: 1, lastVotedAtMs: 5 } },
      cars: {},
    })).toBe(false);
  });
});

describe('pruneEvCarLinkSnapshot', () => {
  it('drops records past the max age and keeps recent ones', () => {
    const snapshot = {
      version: EV_CAR_LINK_VERSION,
      pairs: {
        'old|charger': { votes: 5, lastVotedAtMs: 1_000 },
        'new|charger': { votes: 1, lastVotedAtMs: 9_000 },
      },
      cars: { old: { stopSocPct: [80], lastObservedAtMs: 1_000 } },
    };
    const pruned = pruneEvCarLinkSnapshot({ snapshot, nowMs: 10_000, maxAgeMs: 5_000 });
    expect(Object.keys(pruned.pairs)).toEqual(['new|charger']);
    expect(pruned.cars).toEqual({});
  });

  it('returns the same reference when nothing expired', () => {
    const snapshot = createEmptyEvCarLinkSnapshot();
    expect(pruneEvCarLinkSnapshot({ snapshot, nowMs: 10_000 })).toBe(snapshot);
  });
});

describe('future timestamps', () => {
  it('clamps a future vote timestamp to the load clock', () => {
    // A clock jump or corrupt persisted value would otherwise give the record a
    // negative age, which always passes the retention check — so it could stay a
    // qualified affinity prior forever.
    const normalized = normalizeEvCarLinkSnapshot({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 2, lastVotedAtMs: 9_000 } },
      cars: { car: { stopSocPct: [80], lastObservedAtMs: 9_000 } },
    }, 5_000);
    expect(normalized.pairs['car|charger'].lastVotedAtMs).toBe(5_000);
    expect(normalized.cars.car.lastObservedAtMs).toBe(5_000);
  });

  it('leaves past timestamps alone', () => {
    const normalized = normalizeEvCarLinkSnapshot({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 2, lastVotedAtMs: 1_000 } },
      cars: {},
    }, 5_000);
    expect(normalized.pairs['car|charger'].lastVotedAtMs).toBe(1_000);
  });
});
