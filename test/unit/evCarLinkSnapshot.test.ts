import { describe, expect, it } from 'vitest';
import {
  EV_CAR_LINK_MAX_STOP_SAMPLES,
  EV_CAR_LINK_MAX_TRACKED_CARS,
  EV_CAR_LINK_VERSION,
  buildEvCarLinkPairKey,
  clearEvCarObservedStops,
  createEmptyEvCarLinkSnapshot,
  getEvCarLinkVotes,
  normalizeEvCarLinkSnapshot,
  parseEvCarLinkPairKey,
  pruneEvCarLinkSnapshot,
  recordEvCarLinkVote,
  recordEvCarSelfStopSoc,
  resolveEvCarChargeLimit,
  resolveEvCarChargerMatches,
  summarizeEvCarObservedLimit,
  withLegacyEvCarLinkUnder,
} from '../../lib/device/evCarLinkSnapshot';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';

const normalized = (value: unknown, nowMs = 10_000): EvCarLinkSnapshot => {
  const snapshot = normalizeEvCarLinkSnapshot(value, nowMs);
  if (snapshot === null) throw new Error('not a snapshot');
  return snapshot;
};

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
    const once = recordEvCarLinkVote(createEmptyEvCarLinkSnapshot(), 'car', 'charger', 1_000);
    const twice = recordEvCarLinkVote(once, 'car', 'charger', 2_000);
    expect(getEvCarLinkVotes(twice, 'car', 'charger')).toBe(2);
    expect(twice.pairs[buildEvCarLinkPairKey('car', 'charger')].lastVotedAtMs).toBe(2_000);
  });

  it('keeps pairs independent', () => {
    const snapshot = recordEvCarLinkVote(createEmptyEvCarLinkSnapshot(), 'carA', 'charger', 1);
    expect(getEvCarLinkVotes(snapshot, 'carB', 'charger')).toBe(0);
  });
});

describe('resolveEvCarChargerMatches', () => {
  it('lists the chargers a car was matched to, newest first, and nothing for other cars', () => {
    const snapshot = {
      ...createEmptyEvCarLinkSnapshot(),
      pairs: {
        [buildEvCarLinkPairKey('car-1', 'charger-a')]: { votes: 3, lastVotedAtMs: 1_000 },
        [buildEvCarLinkPairKey('car-1', 'charger-b')]: { votes: 1, lastVotedAtMs: 2_000 },
        [buildEvCarLinkPairKey('car-1', 'charger-c')]: { votes: 0, lastVotedAtMs: 3_000 },
        [buildEvCarLinkPairKey('car-2', 'charger-a')]: { votes: 5, lastVotedAtMs: 4_000 },
      },
    };

    expect(resolveEvCarChargerMatches(snapshot, 'car-1')).toEqual([
      { chargerId: 'charger-b', lastMatchedAtMs: 2_000 },
      { chargerId: 'charger-a', lastMatchedAtMs: 1_000 },
    ]);
    expect(resolveEvCarChargerMatches(snapshot, 'car-3')).toEqual([]);
  });
});

describe('recordEvCarSelfStopSoc', () => {
  it('records in-range samples', () => {
    const snapshot = recordEvCarSelfStopSoc(createEmptyEvCarLinkSnapshot(), 'car', 80, 5);
    expect(snapshot.cars.car.stopSocPct).toEqual([80]);
  });

  it('drops out-of-range readings instead of clamping them', () => {
    // A clamped 0 or 100 would pollute the cluster the probe exists to read.
    const snapshot = recordEvCarSelfStopSoc(createEmptyEvCarLinkSnapshot(), 'car', 140, 5);
    expect(snapshot.cars.car).toBeUndefined();
  });

  it('bounds retained samples', () => {
    const snapshot = Array.from({ length: EV_CAR_LINK_MAX_STOP_SAMPLES + 5 })
      .reduce<ReturnType<typeof createEmptyEvCarLinkSnapshot>>(
        (acc, _unused, index) => recordEvCarSelfStopSoc(acc, 'car', 50 + (index % 10), index + 1),
        createEmptyEvCarLinkSnapshot(),
      );
    expect(snapshot.cars.car.stopSocPct).toHaveLength(EV_CAR_LINK_MAX_STOP_SAMPLES);
  });

  it('refuses a new car past the tracked-car cap but keeps serving known cars', () => {
    const full = Array.from({ length: EV_CAR_LINK_MAX_TRACKED_CARS })
      .reduce<ReturnType<typeof createEmptyEvCarLinkSnapshot>>(
        (acc, _unused, index) => recordEvCarSelfStopSoc(acc, `car${index}`, 80, index + 1),
        createEmptyEvCarLinkSnapshot(),
      );
    const overflowed = recordEvCarSelfStopSoc(full, 'newCar', 80, 99);
    expect(overflowed.cars.newCar).toBeUndefined();
    const known = recordEvCarSelfStopSoc(overflowed, 'car0', 81, 100);
    expect(known.cars.car0.stopSocPct).toEqual([80, 81]);
  });
});

describe('summarizeEvCarObservedLimit', () => {
  const withStops = (stops: number[]) => stops.reduce(
    (acc, socPct, index) => recordEvCarSelfStopSoc(acc, 'car', socPct, index + 1),
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

describe('resolveEvCarChargeLimit', () => {
  const withStops = (stops: number[]) => stops.reduce(
    (acc, socPct, index) => recordEvCarSelfStopSoc(acc, 'car', socPct, index + 1),
    createEmptyEvCarLinkSnapshot(),
  );

  it('qualifies two agreeing stops as the car\'s limit, at the lowest of them', () => {
    // The lowest is a level the car is known to reach: a task capped at 70.5
    // would never read met for a car that stops at 70 tonight.
    expect(resolveEvCarChargeLimit(withStops([70, 70]), 'car')).toBe(70);
    expect(resolveEvCarChargeLimit(withStops([70, 71]), 'car')).toBe(70);
    expect(resolveEvCarChargeLimit(withStops([81, 79, 80]), 'car')).toBe(79);
  });

  it('does not qualify one stop, or stops that disagree', () => {
    expect(resolveEvCarChargeLimit(withStops([70]), 'car')).toBeNull();
    expect(resolveEvCarChargeLimit(withStops([70, 73]), 'car')).toBeNull();
  });

  it('judges the newest stops, so a changed limit is relearned rather than outvoted', () => {
    expect(resolveEvCarChargeLimit(withStops([80, 80, 80, 80, 70, 70]), 'car')).toBeNull();
    expect(resolveEvCarChargeLimit(withStops([80, 80, 80, 80, 70, 70, 70]), 'car')).toBe(70);
  });

  it('forgets a car\'s stops when they are cleared', () => {
    expect(resolveEvCarChargeLimit(clearEvCarObservedStops(withStops([70, 70]), 'car'), 'car')).toBeNull();
  });
});

describe('normalizeEvCarLinkSnapshot', () => {
  it('loads a version-1 blob without the stop samples it banked under the unsound rule', () => {
    const legacy = normalized({
      version: 1,
      pairs: { [buildEvCarLinkPairKey('car', 'charger')]: { votes: 43, lastVotedAtMs: 1_000 } },
      cars: { car: { stopSocPct: [42, 29, 16], lastObservedAtMs: 1_000 } },
      sessions: { charger: { carId: 'car', sinceMs: 500 } },
    });
    expect(legacy.version).toBe(EV_CAR_LINK_VERSION);
    expect(getEvCarLinkVotes(legacy, 'car', 'charger')).toBe(43);
    expect(legacy.sessions).toEqual({ charger: { carId: 'car', sinceMs: 500 } });
    expect(legacy.cars).toEqual({});
  });

  it('answers null for a value that is not a snapshot rather than throwing', () => {
    expect(normalizeEvCarLinkSnapshot(undefined, 0)).toBeNull();
    expect(normalizeEvCarLinkSnapshot('nonsense', 0)).toBeNull();
    expect(normalizeEvCarLinkSnapshot([], 0)).toBeNull();
    expect(normalizeEvCarLinkSnapshot({ version: EV_CAR_LINK_VERSION, pairs: {}, cars: [] }, 0)).toBeNull();
  });

  it('rejects a foreign version', () => {
    expect(normalizeEvCarLinkSnapshot({ version: 99, pairs: {}, cars: {} }, 0)).toBeNull();
  });

  it('drops partial records but keeps valid siblings', () => {
    const snapshot = normalized({
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
    expect(Object.keys(snapshot.pairs)).toEqual(['car|charger']);
    // The out-of-range sample is dropped, the valid siblings survive.
    expect(snapshot.cars.car.stopSocPct).toEqual([80, 81]);
    expect(snapshot.cars.broken).toBeUndefined();
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
      sessions: {},
    };
    const pruned = pruneEvCarLinkSnapshot(snapshot, 10_000, 5_000);
    expect(Object.keys(pruned.pairs)).toEqual(['new|charger']);
    expect(pruned.cars).toEqual({});
  });

  it('returns the same reference when nothing expired', () => {
    const snapshot = createEmptyEvCarLinkSnapshot();
    expect(pruneEvCarLinkSnapshot(snapshot, 10_000)).toBe(snapshot);
  });
});

describe('future timestamps', () => {
  it('clamps a future vote timestamp to the load clock', () => {
    // A clock jump or corrupt persisted value would otherwise give the record a
    // negative age, which always passes the retention check — so it could stay a
    // qualified affinity prior forever.
    const snapshot = normalized({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 2, lastVotedAtMs: 9_000 } },
      cars: { car: { stopSocPct: [80], lastObservedAtMs: 9_000 } },
    }, 5_000);
    expect(snapshot.pairs['car|charger'].lastVotedAtMs).toBe(5_000);
    expect(snapshot.cars.car.lastObservedAtMs).toBe(5_000);
  });

  it('leaves past timestamps alone', () => {
    const snapshot = normalized({
      version: EV_CAR_LINK_VERSION,
      pairs: { 'car|charger': { votes: 2, lastVotedAtMs: 1_000 } },
      cars: {},
    }, 5_000);
    expect(snapshot.pairs['car|charger'].lastVotedAtMs).toBe(1_000);
  });
});

describe('withLegacyEvCarLinkUnder', () => {
  const affinity = (votes: number, lastVotedAtMs: number) => ({ votes, lastVotedAtMs });
  const stops = (pct: number, lastObservedAtMs: number) => ({ stopSocPct: [pct], lastObservedAtMs });

  it('stored entries win per key; the legacy value fills pairs and cars, never sessions', () => {
    const merged = withLegacyEvCarLinkUnder(
      {
        version: EV_CAR_LINK_VERSION,
        pairs: { 'car|charger': affinity(1, 2_000) },
        cars: { car: stops(78, 2_000) },
        sessions: { charger: { carId: 'car', sinceMs: 1_900 } },
      },
      {
        version: EV_CAR_LINK_VERSION,
        pairs: { 'car|charger': affinity(9, 1_000), 'other|charger2': affinity(4, 900) },
        cars: { car: stops(80, 1_000), other: stops(90, 900) },
        sessions: { charger2: { carId: 'other', sinceMs: 800 } },
      },
    );
    // Collisions: the record observed since the upgrade reflects current reality.
    expect(merged.pairs['car|charger'].votes).toBe(1);
    expect(merged.cars.car.stopSocPct).toEqual([78]);
    // Fills: multi-session evidence only the legacy value holds.
    expect(merged.pairs['other|charger2'].votes).toBe(4);
    expect(merged.cars.other.stopSocPct).toEqual([90]);
    // Sessions come from the store ONLY: its absence cannot distinguish
    // "never seen" from "cleared by an observed session end since the
    // upgrade", and re-injecting a cleared session re-arms the documented
    // wrong-resume risk.
    expect(merged.sessions).toEqual({ charger: { carId: 'car', sinceMs: 1_900 } });
  });

  it('keeps the merged car set bounded, dropping legacy entries first', () => {
    const storedCars = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`mem-${i}`, stops(70 + i, 2_000)]),
    );
    const legacyCars = Object.fromEntries(
      Array.from({ length: EV_CAR_LINK_MAX_TRACKED_CARS }, (_, i) => [`old-${i}`, stops(60 + i, 1_000)]),
    );
    const merged = withLegacyEvCarLinkUnder(
      { version: EV_CAR_LINK_VERSION, pairs: {}, cars: storedCars, sessions: {} },
      { version: EV_CAR_LINK_VERSION, pairs: {}, cars: legacyCars, sessions: {} },
    );
    expect(Object.keys(merged.cars)).toHaveLength(EV_CAR_LINK_MAX_TRACKED_CARS);
    // Every stored record survives; the legacy fill takes the remainder.
    expect(Object.keys(merged.cars).filter((id) => id.startsWith('mem-'))).toHaveLength(3);
  });
});
