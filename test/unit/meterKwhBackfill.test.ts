import { dailyKwhFromCounterPoints, resolveMeterDailyKwh } from '../../lib/weather/meterKwhBackfill';

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
// Oslo local midnight in winter is 23:00Z the previous UTC day.
const SERIES_START_MS = Date.UTC(2025, 11, 31, 23, 0, 0); // local 2026-01-01 00:00
const DAY_COUNT = 30;
const NOW_MS = Date.UTC(2026, 0, 31, 12, 0, 0); // local 2026-01-31

const dailyVals = Array.from({ length: DAY_COUNT }, (_, day) => 30 + day * 0.5);

const dateKeyOf = (dayIndex: number): string => `2026-01-${String(1 + dayIndex).padStart(2, '0')}`;

/** Cumulative counter sampled every 6 h, aligned to local midnights. */
const counterValues = (scale = 1, mutate?: (ts: number, v: number) => number): Array<{ t: string; v: number }> => (
  Array.from({ length: DAY_COUNT * 4 + 1 }, (_, index) => {
    const ts = SERIES_START_MS + index * 6 * HOUR_MS;
    const fullDays = Math.floor(index / 4);
    const partial = (index % 4) / 4;
    const consumed = dailyVals.slice(0, fullDays).reduce((sum, value) => sum + value, 0)
      + (fullDays < DAY_COUNT ? dailyVals[fullDays] * partial : 0);
    const value = (1000 + consumed) * scale;
    return { t: new Date(ts).toISOString(), v: mutate ? mutate(ts, value) : value };
  })
);

const DEVICES = {
  'han-1': { id: 'han-1', capabilities: ['measure_power', 'meter_power.imported', 'meter_power.exported'] },
  'thermo-1': { id: 'thermo-1', capabilities: ['meter_power', 'target_temperature'] },
  lamp: { id: 'lamp', capabilities: ['onoff'] },
};

// Tracker covers the trailing 20 days only — the first 10 are the history the meter reconstructs.
const trackerKwh = (dateKey: string): { total?: number } => {
  const dayIndex = dailyVals.findIndex((_, index) => dateKeyOf(index) === dateKey);
  return dayIndex >= 10 ? { total: dailyVals[dayIndex] } : {};
};

type FetchOverrides = Partial<Record<string, (path: string) => unknown>>;

/** Flat export counter at the same timestamps: net diffs equal import diffs. */
const flatExportedValues = (): Array<{ t: string; v: number }> => (
  Array.from({ length: DAY_COUNT * 4 + 1 }, (_, index) => ({
    t: new Date(SERIES_START_MS + index * 6 * HOUR_MS).toISOString(),
    v: 500,
  }))
);

const buildFetch = (overrides: FetchOverrides = {}) => vi.fn(async (path: string) => {
  for (const [needle, handler] of Object.entries(overrides)) {
    if (path.includes(needle)) return handler(path);
  }
  if (path === 'manager/devices/device') return DEVICES;
  if (path.includes('han-1:meter_power.imported')) return { step: 6 * HOUR_MS, values: counterValues() };
  if (path.includes('han-1:meter_power.exported')) return { step: 6 * HOUR_MS, values: flatExportedValues() };
  // A device-level meter: right shape, wrong magnitude (~30% of the home).
  if (path.includes('thermo-1:meter_power')) return { step: 6 * HOUR_MS, values: counterValues(0.3) };
  throw new Error(`unexpected path ${path}`);
});

describe('resolveMeterDailyKwh', () => {
  it('adopts the meter whose daily diffs match the tracker and reconstructs pre-tracker days', async () => {
    const fetchFromHomeyApi = buildFetch();
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.deviceId).toBe('han-1');
    expect(result.capability).toBe('meter_power.imported');
    expect(result.complete).toBe(true);
    expect(result.overlapDays).toBe(20);
    expect(result.medianRatio).toBeCloseTo(1, 6);
    expect(Object.keys(result.dailyKwh)).toHaveLength(DAY_COUNT);
    // The first ten days exist nowhere in the tracker — the point of the backfill.
    expect(result.dailyKwh[dateKeyOf(0)]).toBeCloseTo(dailyVals[0], 6);
    expect(result.dailyKwh['2026-01-31']).toBeUndefined();
  });

  it('rejects a device-subset meter and reports no comparable source', async () => {
    const fetchFromHomeyApi = buildFetch({
      'manager/devices/device': () => ({ 'thermo-1': DEVICES['thermo-1'] }),
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result).toEqual({ outcome: 'no_comparable_source', candidatesChecked: 1, probeFailures: 0 });
  });

  it('reports probe failures so the caller knows the verdict rests on unread evidence', async () => {
    const fetchFromHomeyApi = buildFetch({
      'meter_power': () => {
        throw new Error('insights down');
      },
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result).toEqual({ outcome: 'no_comparable_source', candidatesChecked: 2, probeFailures: 2 });
  });

  it('reports no_candidates when no device exposes a cumulative meter', async () => {
    const fetchFromHomeyApi = buildFetch({
      'manager/devices/device': () => ({ lamp: DEVICES.lamp }),
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result).toEqual({ outcome: 'no_candidates' });
  });

  it('refuses validation when the tracker overlap is too thin', async () => {
    const fetchFromHomeyApi = buildFetch();
    const fiveDayTracker = (dateKey: string): { total?: number } => (
      dateKey >= dateKeyOf(25) ? trackerKwh(dateKey) : {}
    );
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: fiveDayTracker, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result).toEqual({ outcome: 'no_comparable_source', candidatesChecked: 2, probeFailures: 0 });
  });

  it('drops only the reset day on a counter swap and the surrounding days on a sample gap', async () => {
    const resetAtMs = SERIES_START_MS + (15 * 4 + 2) * 6 * HOUR_MS; // mid local day 16
    const gapBoundaryMs = SERIES_START_MS + 5 * 4 * 6 * HOUR_MS; // local midnight day 6
    const fetchFromHomeyApi = buildFetch({
      'han-1:meter_power.imported': () => ({
        step: 6 * HOUR_MS,
        // Drop ~the counter's accumulated total so far: stays ≥ 0 (a negative
        // counter would be rejected as implausible, not read as a reset).
        values: counterValues(1, (ts, value) => (ts >= resetAtMs ? value - 1500 : value))
          .filter((entry) => Date.parse(entry.t) !== gapBoundaryMs),
      }),
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    // Counter reset inside day 16: that day's diff is negative and dropped.
    expect(result.dailyKwh[dateKeyOf(15)]).toBeUndefined();
    expect(result.dailyKwh[dateKeyOf(16)]).toBeCloseTo(dailyVals[16], 6);
    // Missing midnight sample: both days sharing that boundary are dropped.
    expect(result.dailyKwh[dateKeyOf(4)]).toBeUndefined();
    expect(result.dailyKwh[dateKeyOf(5)]).toBeUndefined();
    expect(result.dailyKwh[dateKeyOf(6)]).toBeCloseTo(dailyVals[6], 6);
  });

  it('returns complete=false when a deep resolution window fails', async () => {
    const fetchFromHomeyApi = buildFetch({
      'resolution=lastYear': () => {
        throw new Error('insights down');
      },
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.complete).toBe(false);
    expect(result.dailyKwh[dateKeyOf(0)]).toBeCloseTo(dailyVals[0], 6);
  });

  it('counts a malformed or too-coarse window as a failure, and a well-formed empty one as final', async () => {
    const tooCoarse = buildFetch({
      'resolution=lastYear': () => ({ step: 24 * HOUR_MS, values: counterValues() }),
    });
    const coarse = await resolveMeterDailyKwh({
      fetchFromHomeyApi: tooCoarse, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(coarse.outcome).toBe('resolved');
    if (coarse.outcome === 'resolved') expect(coarse.complete).toBe(false);

    const legitimatelyEmpty = buildFetch({
      'resolution=lastYear': () => ({ step: 6 * HOUR_MS, values: [] }),
    });
    const empty = await resolveMeterDailyKwh({
      fetchFromHomeyApi: legitimatelyEmpty, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(empty.outcome).toBe('resolved');
    if (empty.outcome === 'resolved') expect(empty.complete).toBe(true);
  });

  it('blocks the latch when any candidate probe failed its election round', async () => {
    const fetchFromHomeyApi = buildFetch({
      'thermo-1:meter_power': () => {
        throw new Error('probe timeout');
      },
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.deviceId).toBe('han-1');
    expect(result.complete).toBe(false);
  });

  it('adopts an import meter whose export log is conclusively empty (gross = net)', async () => {
    const fetchFromHomeyApi = buildFetch({
      'han-1:meter_power.exported': () => ({ step: 6 * HOUR_MS, values: [] }),
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.complete).toBe(true);
    expect(result.dailyKwh[dateKeyOf(0)]).toBeCloseTo(dailyVals[0], 6);
  });

  it('writes nothing when only the export side of the winner is unreadable', async () => {
    const fetchFromHomeyApi = buildFetch({
      'han-1:meter_power.exported': () => {
        throw new Error('insights down');
      },
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    // The probe cannot net without the export counter: the candidate is
    // skipped and the verdict is flagged as resting on unread evidence.
    expect(result).toEqual({ outcome: 'no_comparable_source', candidatesChecked: 2, probeFailures: 1 });
  });

  it('falls back to gross import when an import window fails but the export log is conclusively empty', async () => {
    const fetchFromHomeyApi = buildFetch({
      'meter_power.imported/entry?resolution=lastYear': () => {
        throw new Error('insights down');
      },
      'han-1:meter_power.exported': () => ({ step: 6 * HOUR_MS, values: [] }),
    });
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: trackerKwh, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    // The import-side failure must not poison the export verdict: the other
    // import windows still fill, just without the done-marker.
    expect(result.complete).toBe(false);
    expect(result.dailyKwh[dateKeyOf(0)]).toBeCloseTo(dailyVals[0], 6);
  });

  it('pairs the export counter with a generic meter_power import counter too', async () => {
    const EXPORT_PER_DAY = 4;
    const fetchFromHomeyApi = buildFetch({
      'manager/devices/device': () => ({
        'bidi-1': { id: 'bidi-1', capabilities: ['meter_power', 'meter_power.exported'] },
      }),
      'bidi-1:meter_power.exported': () => ({
        step: 6 * HOUR_MS,
        values: Array.from({ length: DAY_COUNT * 4 + 1 }, (_, index) => ({
          t: new Date(SERIES_START_MS + index * 6 * HOUR_MS).toISOString(),
          v: 200 + index * (EXPORT_PER_DAY / 4),
        })),
      }),
      'bidi-1:meter_power/': () => ({ step: 6 * HOUR_MS, values: counterValues() }),
    });
    const netTracker = (dateKey: string): { total?: number } => {
      const gross = trackerKwh(dateKey).total;
      return gross === undefined ? {} : { total: gross - EXPORT_PER_DAY };
    };
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: netTracker, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.deviceId).toBe('bidi-1');
    expect(result.dailyKwh[dateKeyOf(0)]).toBeCloseTo(dailyVals[0] - EXPORT_PER_DAY, 6);
  });

  it('nets out the export counter so PV-export days stay on the tracker metric', async () => {
    const EXPORT_PER_DAY = 5;
    const fetchFromHomeyApi = buildFetch({
      'han-1:meter_power.exported': () => ({
        step: 6 * HOUR_MS,
        values: Array.from({ length: DAY_COUNT * 4 + 1 }, (_, index) => ({
          t: new Date(SERIES_START_MS + index * 6 * HOUR_MS).toISOString(),
          v: 500 + index * (EXPORT_PER_DAY / 4),
        })),
      }),
    });
    // The tracker measures NET on an exporting home.
    const netTracker = (dateKey: string): { total?: number } => {
      const gross = trackerKwh(dateKey).total;
      return gross === undefined ? {} : { total: gross - EXPORT_PER_DAY };
    };
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi, getDailyKwh: netTracker, timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.medianRatio).toBeCloseTo(1, 6);
    expect(result.dailyKwh[dateKeyOf(0)]).toBeCloseTo(dailyVals[0] - EXPORT_PER_DAY, 6);
  });
});

describe('dailyKwhFromCounterPoints', () => {
  const flatRateCounter = (startMs: number, steps: number): Map<number, number> => new Map(
    Array.from({ length: steps + 1 }, (_, index) => [startMs + index * 6 * HOUR_MS, index * 10]),
  );

  it('partitions the counter exactly across the spring DST transition', () => {
    // Oslo jumps CET→CEST on 2026-03-29 (a 23-hour local day).
    const startMs = Date.UTC(2026, 2, 25, 0, 0, 0);
    const steps = 8 * 4;
    const daily = dailyKwhFromCounterPoints(
      { imported: flatRateCounter(startMs, steps) },
      OSLO,
      '2026-04-05',
    );
    const values = Object.values(daily);
    expect(Object.keys(daily)).toContain('2026-03-29');
    expect(values).toHaveLength(8);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(30);
      expect(value).toBeLessThanOrEqual(50);
    }
    // No energy lost or double-counted between the shifted boundaries.
    const total = values.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(steps * 10, 6);
  });

  it('handles half-hour-offset timezones within the boundary tolerance', () => {
    // St. John's runs UTC−3:30 in winter: local midnight is 2.5 h from the grid.
    const startMs = Date.UTC(2026, 0, 10, 0, 0, 0);
    const daily = dailyKwhFromCounterPoints(
      { imported: flatRateCounter(startMs, 6 * 4) },
      'America/St_Johns',
      '2026-02-01',
    );
    const dateKeys = Object.keys(daily).sort();
    expect(dateKeys.length).toBeGreaterThanOrEqual(5);
    // Interior days are partition-exact; the first/last day of a series may
    // pair an asymmetric edge boundary (documented, absorbed by the fit).
    for (const dateKey of dateKeys.slice(0, -1)) expect(daily[dateKey]).toBeCloseTo(40, 6);
  });
});
