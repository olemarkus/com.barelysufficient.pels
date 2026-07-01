import { describe, expect, it } from 'vitest';
import {
  classifyHourNetEvidence,
  emptyPvGenerationHistory,
  PV_HOUR_MIN_COVERAGE,
  PV_SAMPLE_MAX_GAP_MS,
  PV_UNCLAMPED_EXPORT_MIN_MS,
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

describe('recordPvSample net evidence', () => {
  it('the first sample anchors lastNetW without integrating', () => {
    const s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE, { netW: -300 });
    expect(s.lastNetW).toBe(-300);
    expect(s.hourly).toEqual({});
  });

  it('splits carried import evidence proportionally across an hour boundary', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 3000, BASE + HOUR_MS - 5_000, { netW: 800 });
    s = recordPvSample(s, 3000, BASE + HOUR_MS + 5_000, { netW: 800 });
    // carried +800 W > the 500 W import bar ⇒ both hour segments accrue import evidence
    expect(s.hourly[HOUR_KEY]).toEqual({
      kwh: kwh(3000, 5_000), coveredMs: 5_000, netMs: 5_000, importMs: 5_000, exportMs: 0,
    });
    expect(s.hourly[NEXT_HOUR_KEY]).toEqual({
      kwh: kwh(3000, 5_000), coveredMs: 5_000, netMs: 5_000, importMs: 5_000, exportMs: 0,
    });
  });

  it('splits dual-endpoint export evidence proportionally across an hour boundary', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 3000, BASE + HOUR_MS - 5_000, { netW: -200 });
    s = recordPvSample(s, 3000, BASE + HOUR_MS + 5_000, { netW: -250 });
    expect(s.hourly[HOUR_KEY]).toEqual({
      kwh: kwh(3000, 5_000), coveredMs: 5_000, netMs: 5_000, importMs: 0, exportMs: 5_000,
    });
    expect(s.hourly[NEXT_HOUR_KEY]).toEqual({
      kwh: kwh(3000, 5_000), coveredMs: 5_000, netMs: 5_000, importMs: 0, exportMs: 5_000,
    });
  });

  it('a sample WITHOUT netW drops lastNetW and stops netMs accrual (spread-bug pin)', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE, { netW: 700 });
    s = recordPvSample(s, 2000, BASE + 10_000); // no netW
    // the interval itself was covered by the carried +700 W reading…
    expect(s.hourly[HOUR_KEY].coveredMs).toBe(10_000);
    expect(s.hourly[HOUR_KEY].netMs).toBe(10_000);
    expect(s.hourly[HOUR_KEY].importMs).toBe(10_000);
    // …but the anchor must be DROPPED, not silently re-spread from the old history.
    expect(s.lastNetW).toBeUndefined();
    s = recordPvSample(s, 2000, BASE + 20_000, { netW: 700 });
    // no carried net over [10s, 20s) ⇒ coverage grows, net evidence does not
    expect(s.hourly[HOUR_KEY].coveredMs).toBe(20_000);
    expect(s.hourly[HOUR_KEY].netMs).toBe(10_000);
    expect(s.hourly[HOUR_KEY].importMs).toBe(10_000);
    expect(s.lastNetW).toBe(700);
  });

  it('a gap re-anchor accrues no evidence and still taints', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 2000, BASE + 57 * 60_000, { netW: 900 });
    s = recordPvSample(s, 2000, BASE + 63 * 60_000, { netW: 900 }); // 6 min gap > 5 min max
    expect(s.hourly).toEqual({});
    expect(s.taintedHourStarts).toEqual({ [HOUR_KEY]: true, [NEXT_HOUR_KEY]: true });
    expect(s.lastNetW).toBe(900); // re-anchored for the next interval
  });

  it('choppy hour: single-sample export blips summing past 10 min never accrue exportMs', () => {
    // 60 s cadence over a full hour; even samples read −500 W (export blip), odd
    // +50 W. Carried-export intervals sum to 30 min single-endpoint, but no TWO
    // CONSECUTIVE readings export ⇒ dual-endpoint exportMs stays 0 ⇒ 'suspect'.
    let s = recordPvSample(emptyPvGenerationHistory(), 1000, BASE, { netW: -500 });
    for (let i = 1; i <= 60; i += 1) {
      s = recordPvSample(s, 1000, BASE + i * 60_000, { netW: i % 2 === 0 ? -500 : 50 });
    }
    const bucket = s.hourly[HOUR_KEY];
    expect(bucket.coveredMs).toBe(HOUR_MS);
    expect(bucket.netMs).toBe(HOUR_MS);
    expect(bucket.exportMs).toBe(0);
    expect(bucket.importMs).toBe(0); // ±50/−500 never clears the +500 import bar
    expect(classifyHourNetEvidence(bucket)).toBe('suspect');
  });

  it('a +150 W standing import all hour stays suspect (below the import evidence bar)', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 1000, BASE, { netW: 150 });
    for (let i = 1; i <= 60; i += 1) {
      s = recordPvSample(s, 1000, BASE + i * 60_000, { netW: 150 });
    }
    expect(classifyHourNetEvidence(s.hourly[HOUR_KEY])).toBe('suspect');
    // …and pvTrainingHours stamps the producer-resolved evidence on the sample.
    const hours = pvTrainingHours(s);
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ hourStartMs: BASE, netEvidence: 'suspect' });
    expect(hours[0].generationKwh).toBeCloseTo(1, 9);
  });

  it('a sustained-import hour classifies unclamped end to end', () => {
    let s = recordPvSample(emptyPvGenerationHistory(), 1000, BASE, { netW: 800 });
    for (let i = 1; i <= 60; i += 1) {
      s = recordPvSample(s, 1000, BASE + i * 60_000, { netW: 800 });
    }
    const hours = pvTrainingHours(s);
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ hourStartMs: BASE, netEvidence: 'unclamped' });
    expect(hours[0].generationKwh).toBeCloseTo(1, 9);
  });
});

describe('classifyHourNetEvidence', () => {
  const HOUR = HOUR_MS;

  it('classifies the import / export / suspect / unknown matrix', () => {
    // import route: >= 95% of net-covered time importing
    expect(classifyHourNetEvidence({ kwh: 1, coveredMs: HOUR, netMs: HOUR, importMs: 0.96 * HOUR, exportMs: 0 }))
      .toBe('unclamped');
    expect(classifyHourNetEvidence({ kwh: 1, coveredMs: HOUR, netMs: HOUR, importMs: 0.9 * HOUR, exportMs: 0 }))
      .toBe('suspect');
    // export route: >= 10 min cumulative dual-endpoint export
    expect(classifyHourNetEvidence({
      kwh: 1, coveredMs: HOUR, netMs: HOUR, importMs: 0, exportMs: PV_UNCLAMPED_EXPORT_MIN_MS,
    })).toBe('unclamped');
    expect(classifyHourNetEvidence({
      kwh: 1, coveredMs: HOUR, netMs: HOUR, importMs: 0, exportMs: PV_UNCLAMPED_EXPORT_MIN_MS - 1,
    })).toBe('suspect');
    // measured-with-zeros (balanced load / clamp) is suspect, not unknown
    expect(classifyHourNetEvidence({ kwh: 1, coveredMs: HOUR, netMs: HOUR, importMs: 0, exportMs: 0 }))
      .toBe('suspect');
    // partial net coverage (< 95% of covered time) cannot classify
    expect(classifyHourNetEvidence({ kwh: 1, coveredMs: HOUR, netMs: 0.9 * HOUR, importMs: 0.9 * HOUR, exportMs: 0 }))
      .toBe('unknown');
    // legacy bucket without evidence fields
    expect(classifyHourNetEvidence({ kwh: 1, coveredMs: HOUR })).toBe('unknown');
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
      { hourStartMs: BASE, generationKwh: 0.4, netEvidence: 'unknown' },
      { hourStartMs: BASE + 2 * HOUR_MS, generationKwh: 1.5, netEvidence: 'unknown' },
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
    expect(pvTrainingHours(history)).toEqual([{ hourStartMs: BASE, generationKwh: 0.4, netEvidence: 'unknown' }]);
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
    expect(pvTrainingHours(history, 0.6))
      .toEqual([{ hourStartMs: BASE, generationKwh: 1, netEvidence: 'unknown' }]);
    // The bar sits above 1 − maxGap/hour so any re-anchored hole is excluded.
    expect(PV_HOUR_MIN_COVERAGE).toBe(0.95);
    expect(PV_HOUR_MIN_COVERAGE).toBeGreaterThan(1 - PV_SAMPLE_MAX_GAP_MS / HOUR_MS);
  });
});
