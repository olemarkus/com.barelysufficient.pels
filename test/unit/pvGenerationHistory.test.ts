import { describe, expect, it } from 'vitest';
import {
  emptyPvGenerationHistory,
  PV_HOUR_MIN_COVERAGE,
  PV_SAMPLE_MAX_GAP_MS,
  pruneOldHours,
  pvTrainingHours,
  recordPvSample,
  type PvGenerationHistory,
} from '../../packages/shared-domain/src/solar/pvGenerationHistory';

const HOUR_MS = 3_600_000;
const BASE = Date.UTC(2026, 5, 21, 10, 0, 0); // a UTC hour boundary
const HOUR_KEY = String(BASE);
const NEXT_HOUR_KEY = String(BASE + HOUR_MS);

const kwh = (w: number, ms: number): number => (w / 1000) * (ms / HOUR_MS);
const fullHour = (kwhValue: number): { kwh: number; coveredMs: number } => ({ kwh: kwhValue, coveredMs: HOUR_MS });

describe('recordPvSample', () => {
  it('the first sample only anchors — it integrates nothing', () => {
    const s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE);
    expect(s.lastSampleMs).toBe(BASE);
    expect(s.lastGenerationW).toBe(2000);
    expect(s.hourly).toEqual({});
  });

  it('integrates the held power into the previous hour with its sampled coverage', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE);
    s = recordPvSample(s, 4000, BASE + 10_000); // 10 s at the carried 2000 W
    expect(s.hourly[HOUR_KEY].kwh).toBeCloseTo(kwh(2000, 10_000), 9);
    expect(s.hourly[HOUR_KEY].coveredMs).toBe(10_000);
    expect(s.lastGenerationW).toBe(4000);
  });

  it('accumulates a full hour of 10 s samples to ~the energy area with full coverage', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE);
    for (let t = 10_000; t <= HOUR_MS; t += 10_000) {
      s = recordPvSample(s, 2000, BASE + t);
    }
    expect(s.hourly[HOUR_KEY].kwh).toBeCloseTo(2.0, 2);
    expect(s.hourly[HOUR_KEY].coveredMs).toBeCloseTo(HOUR_MS, 0);
    // A fully-covered completed hour is trainable.
    expect(pvTrainingHours(s)).toHaveLength(1);
    expect(pvTrainingHours(s)[0].hourStartMs).toBe(BASE);
  });

  it('splits a boundary-straddling interval proportionally across both hours', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 3000, BASE + HOUR_MS - 5_000); // hour 10
    s = recordPvSample(s, 3000, BASE + HOUR_MS + 5_000); // crosses into hour 11
    expect(s.hourly[HOUR_KEY].kwh).toBeCloseTo(kwh(3000, 5_000), 9);
    expect(s.hourly[HOUR_KEY].coveredMs).toBe(5_000);
    expect(s.hourly[NEXT_HOUR_KEY].kwh).toBeCloseTo(kwh(3000, 5_000), 9);
    expect(s.hourly[NEXT_HOUR_KEY].coveredMs).toBe(5_000);
    // Both hours are only 5 s covered → neither is trainable.
    expect(pvTrainingHours(s)).toEqual([]);
  });

  it('re-anchors (no integration) across a gap larger than the max', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE);
    s = recordPvSample(s, 2000, BASE + 10_000);
    const before = { ...s.hourly };
    s = recordPvSample(s, 2000, BASE + 10_000 + 10 * 60_000); // 10 min gap > 5 min max
    expect(s.hourly).toEqual(before);
    expect(s.lastSampleMs).toBe(BASE + 10_000 + 10 * 60_000);
  });

  it('ignores out-of-order samples (cursor stays monotonic) and clamps bad power', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE + 20_000);
    s = recordPvSample(s, 2000, BASE + 10_000); // earlier than last
    expect(s.hourly).toEqual({});
    expect(s.lastSampleMs).toBe(BASE + 20_000); // not rewound

    expect(recordPvSample(emptyPvGenerationHistory(), -500, BASE).lastGenerationW).toBe(0);
    expect(recordPvSample(emptyPvGenerationHistory(), Number.NaN, BASE).lastGenerationW).toBe(0);
  });

  it('taints both boundary hours a straddling gap touched', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 3000, BASE + 57 * 60_000); // anchor 10:57
    s = recordPvSample(s, 3000, BASE + 63 * 60_000); // 11:03 — a 6 min gap (> 5 min max)
    expect(s.taintedHourStarts).toEqual({ [HOUR_KEY]: true, [NEXT_HOUR_KEY]: true });
  });

  it('does not taint the hour a gap ends exactly on its boundary', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 3000, BASE + 53 * 60_000); // anchor 10:53
    s = recordPvSample(s, 3000, BASE + HOUR_MS); // exactly 11:00 — a 7 min gap, no hole in hour 11
    expect(s.taintedHourStarts).toEqual({ [HOUR_KEY]: true });
  });
});

describe('pruneOldHours', () => {
  it('drops hours older than the retention window, keeps recent ones', () => {
    const now = BASE + 100 * HOUR_MS;
    const history: PvGenerationHistory = {
      hourly: { [String(BASE)]: fullHour(1), [String(BASE + 90 * HOUR_MS)]: fullHour(2) },
    };
    const pruned = pruneOldHours(history, now, 24 * HOUR_MS);
    expect(pruned.hourly[String(BASE)]).toBeUndefined();
    expect(pruned.hourly[String(BASE + 90 * HOUR_MS)]).toEqual(fullHour(2));
  });

  it('also prunes aged-out tainted hour markers', () => {
    const now = BASE + 100 * HOUR_MS;
    const history: PvGenerationHistory = {
      hourly: {},
      taintedHourStarts: { [String(BASE)]: true, [String(BASE + 90 * HOUR_MS)]: true },
    };
    expect(pruneOldHours(history, now, 24 * HOUR_MS).taintedHourStarts)
      .toEqual({ [String(BASE + 90 * HOUR_MS)]: true });
  });
});

describe('pvTrainingHours', () => {
  it('returns positive, fully-covered hours ascending and excludes zero/partial/open hours', () => {
    const history: PvGenerationHistory = {
      lastSampleMs: BASE + 3 * HOUR_MS + 30 * 60_000, // open hour = BASE+3h
      lastGenerationW: 1000,
      hourly: {
        [String(BASE + 2 * HOUR_MS)]: fullHour(1.5), // complete
        [String(BASE)]: fullHour(0.4), // complete
        [String(BASE + HOUR_MS)]: fullHour(0), // night — zero generation, excluded
        [String(BASE + 4 * HOUR_MS)]: { kwh: 0.6, coveredMs: 0.5 * HOUR_MS }, // outage hole, excluded
        [String(BASE + 3 * HOUR_MS)]: { kwh: 0.7, coveredMs: 0.5 * HOUR_MS }, // open, partial, excluded
      },
    };
    expect(pvTrainingHours(history)).toEqual([
      { hourStartMs: BASE, generationKwh: 0.4 },
      { hourStartMs: BASE + 2 * HOUR_MS, generationKwh: 1.5 },
    ]);
  });

  it('excludes the live open hour even once it exceeds the coverage gate', () => {
    const openStart = BASE + 5 * HOUR_MS;
    const history: PvGenerationHistory = {
      lastSampleMs: openStart + 0.95 * HOUR_MS, // 95% into the open hour — past the 0.9 gate
      lastGenerationW: 1000,
      hourly: {
        [String(BASE)]: fullHour(0.4),
        [String(openStart)]: { kwh: 0.9, coveredMs: 0.95 * HOUR_MS }, // open, still excluded
      },
    };
    expect(pvTrainingHours(history)).toEqual([{ hourStartMs: BASE, generationKwh: 0.4 }]);
  });

  it('excludes gap-tainted hours even at full coverage (boundary-straddling gap)', () => {
    const history: PvGenerationHistory = {
      lastSampleMs: BASE + 3 * HOUR_MS,
      hourly: { [HOUR_KEY]: fullHour(1.0), [NEXT_HOUR_KEY]: fullHour(1.2) },
      taintedHourStarts: { [HOUR_KEY]: true, [NEXT_HOUR_KEY]: true },
    };
    expect(pvTrainingHours(history)).toEqual([]);
  });

  it('excludes a gap-holed hour that a 0.9 bar would have admitted', () => {
    // 10:00–10:55 sampled, then a >5 min gap: 55/60 = 0.917 coverage — under 0.95.
    const history: PvGenerationHistory = {
      lastSampleMs: BASE + 2 * HOUR_MS, // cursor moved on; BASE is a closed, holed hour
      hourly: { [String(BASE)]: { kwh: 1.2, coveredMs: (55 / 60) * HOUR_MS } },
    };
    expect(pvTrainingHours(history)).toEqual([]);
  });

  it('honours a custom coverage threshold', () => {
    const history: PvGenerationHistory = {
      hourly: { [String(BASE)]: { kwh: 1, coveredMs: 0.7 * HOUR_MS } },
    };
    expect(pvTrainingHours(history)).toEqual([]); // below default 0.95
    expect(pvTrainingHours(history, 0.6)).toEqual([{ hourStartMs: BASE, generationKwh: 1 }]);
    // The bar sits above 1 − maxGap/hour so any re-anchored hole is excluded.
    expect(PV_HOUR_MIN_COVERAGE).toBe(0.95);
    expect(PV_HOUR_MIN_COVERAGE).toBeGreaterThan(1 - PV_SAMPLE_MAX_GAP_MS / HOUR_MS);
  });
});
