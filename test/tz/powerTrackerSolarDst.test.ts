import { aggregateAndPruneHistory } from '../../lib/power/tracker';

// PR-5 solar visibility: the generation/export prune fold must key daily
// totals by the Homey-local calendar day, exactly like the billed families
// (see powerTrackerDst.test.ts). Both Europe/Oslo DST transitions are
// exercised so the 23-hour spring-forward and 25-hour fall-back days fold
// whole and land on the right local key regardless of host TZ.

const OSLO = 'Europe/Oslo';
const HOURLY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const isoHour = (utcMs: number): string => new Date(utcMs).toISOString();

const buildDayBuckets = (startUtcMs: number, endUtcMs: number, kWhPerHour: number): Record<string, number> => {
  const buckets: Record<string, number> = {};
  for (let ts = startUtcMs; ts <= endUtcMs; ts += HOUR_MS) {
    buckets[isoHour(ts)] = kWhPerHour;
  }
  return buckets;
};

describe('aggregateAndPruneHistory — solar family DST prune folds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('folds all 23 hours of a spring-forward Oslo day into one generation daily total', () => {
    // 2026-03-29 Oslo has 23 local hours (02:00 → 03:00 jumps forward).
    const startUtc = Date.UTC(2026, 2, 28, 23, 0, 0); // 2026-03-29 00:00 Oslo (UTC+1)
    const endUtc = Date.UTC(2026, 2, 29, 21, 0, 0);   // 2026-03-29 23:00 Oslo (UTC+2)
    const generationBuckets = buildDayBuckets(startUtc, endUtc, 0.1);
    expect(Object.keys(generationBuckets)).toHaveLength(23);

    vi.setSystemTime(endUtc + HOURLY_RETENTION_MS + 24 * HOUR_MS);
    const pruned = aggregateAndPruneHistory({ buckets: {}, generationBuckets }, { timeZone: OSLO });

    expect(pruned.generationBuckets).toEqual({});
    expect(pruned.generationDailyTotals?.['2026-03-29']).toBeCloseTo(2.3, 6);
    // Total kWh preserved across the fold.
    const total = Object.values(pruned.generationDailyTotals ?? {}).reduce((acc, v) => acc + v, 0);
    expect(total).toBeCloseTo(2.3, 6);
  });

  it('folds all 25 hours of a fall-back Oslo day into one export daily total', () => {
    // 2026-10-25 Oslo has 25 local hours (02:00–03:00 repeats).
    const startUtc = Date.UTC(2026, 9, 24, 22, 0, 0); // 2026-10-25 00:00 Oslo (UTC+2)
    const endUtc = Date.UTC(2026, 9, 25, 22, 0, 0);   // 2026-10-25 23:00 Oslo (UTC+1)
    const exportBuckets = buildDayBuckets(startUtc, endUtc, 0.1);
    expect(Object.keys(exportBuckets)).toHaveLength(25);

    vi.setSystemTime(endUtc + HOURLY_RETENTION_MS + 24 * HOUR_MS);
    const pruned = aggregateAndPruneHistory({ buckets: {}, exportBuckets }, { timeZone: OSLO });

    expect(pruned.exportBuckets).toEqual({});
    expect(pruned.exportDailyTotals?.['2026-10-25']).toBeCloseTo(2.5, 6);
    // The untouched sibling family must not appear.
    expect('generationBuckets' in pruned).toBe(false);
    expect('generationDailyTotals' in pruned).toBe(false);
  });
});
