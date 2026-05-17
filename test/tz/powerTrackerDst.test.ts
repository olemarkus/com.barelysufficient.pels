import { aggregateAndPruneHistory } from '../../lib/core/powerTracker';

// Regression suite for TODO `power-tracker-tz-fix`: dailyTotals must be keyed by the
// Homey-local calendar day. Without the timezone option, samples that fall on the wrong
// side of UTC midnight from the user's perspective end up on the previous or next day,
// double-counting at the local/UTC boundary and mis-aligning with bucket-derived
// totals in `packages/settings-ui/src/ui/power.ts`.
//
// Both DST transitions in Europe/Oslo are exercised:
//   - Spring-forward: 2026-03-29 has 23 local hours (02:00 → 03:00 jumps forward).
//   - Fall-back:      2026-10-25 has 25 local hours (03:00 → 02:00 repeats).
// On those days the wrong-day bug surfaces in either direction.

const OSLO = 'Europe/Oslo';

const HOURLY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const isoHour = (utcDateMs: number): string => new Date(utcDateMs).toISOString();

describe('aggregateAndPruneHistory — Homey-local dailyTotals keying (DST regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attributes a late-evening Oslo winter sample to the local day, not the UTC day', () => {
    // 2026-01-15 23:30 Europe/Oslo (UTC+1 winter) is 2026-01-15 22:30 UTC.
    // UTC-keyed code would still record this on 2026-01-15, so pick a tighter case:
    // 2026-01-16 00:30 Europe/Oslo = 2026-01-15 23:30 UTC. Local key must be 2026-01-16.
    const sampleUtcMs = Date.UTC(2026, 0, 15, 23, 0, 0);
    // Make sample "old" so aggregation rolls it into dailyTotals (older than 30-day hourly retention).
    const now = sampleUtcMs + HOURLY_RETENTION_MS + 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);

    const pruned = aggregateAndPruneHistory(
      { buckets: { [isoHour(sampleUtcMs)]: 1.5 } },
      { timeZone: OSLO },
    );

    expect(pruned.dailyTotals).toEqual({ '2026-01-16': 1.5 });
  });

  it('attributes a late-evening Oslo summer sample (UTC+2) to the local day', () => {
    // 2026-07-15 23:30 Oslo (UTC+2 DST) = 2026-07-15 21:30 UTC. Local key must be 2026-07-15.
    // The interesting boundary case is 2026-07-16 01:30 Oslo = 2026-07-15 23:30 UTC.
    const sampleUtcMs = Date.UTC(2026, 6, 15, 23, 0, 0);
    const now = sampleUtcMs + HOURLY_RETENTION_MS + 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);

    const pruned = aggregateAndPruneHistory(
      { buckets: { [isoHour(sampleUtcMs)]: 2 } },
      { timeZone: OSLO },
    );

    expect(pruned.dailyTotals).toEqual({ '2026-07-16': 2 });
  });

  it('groups all 23 hours of a spring-forward Oslo day under the same local key', () => {
    // 2026-03-29 is the Europe/Oslo DST spring-forward day (23 local hours).
    // UTC offsets: before 01:00 UTC the local offset is +1; from 01:00 UTC it becomes +2.
    // Local hours: 00, 01, (skipped 02), 03..23 — 23 distinct hour-of-day buckets.
    const sampleUtcStart = Date.UTC(2026, 2, 28, 23, 0, 0); // 2026-03-29 00:00 Oslo (UTC+1)
    const sampleUtcEnd = Date.UTC(2026, 2, 29, 22, 0, 0);   // 2026-03-29 23:00 Oslo (UTC+2 by then)

    const buckets: Record<string, number> = {};
    for (let ts = sampleUtcStart; ts <= sampleUtcEnd; ts += 60 * 60 * 1000) {
      buckets[isoHour(ts)] = 0.1;
    }

    const now = sampleUtcEnd + HOURLY_RETENTION_MS + 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);

    const pruned = aggregateAndPruneHistory({ buckets }, { timeZone: OSLO });

    // Some samples land on 2026-03-29 local; one or two may straddle into 2026-03-30 local.
    // The invariant: total kWh preserved, and 2026-03-29 has exactly 23h worth (2.3 kWh)
    // because the local 02:00–03:00 hour does not exist that day.
    const total = Object.values(pruned.dailyTotals ?? {}).reduce((acc, v) => acc + v, 0);
    expect(total).toBeCloseTo(Object.values(buckets).reduce((acc, v) => acc + v, 0), 6);
    expect(pruned.dailyTotals?.['2026-03-29']).toBeCloseTo(2.3, 6);
  });

  it('groups all 25 hours of a fall-back Oslo day under the same local key', () => {
    // 2026-10-25 is the Europe/Oslo DST fall-back day (25 local hours; 02:00–03:00 repeats).
    // Local offset before 01:00 UTC: +2; from 01:00 UTC: +1.
    // Local hours: 00, 01, 02 (first), 02 (second), 03..23 — 25 hour-of-day occurrences.
    const sampleUtcStart = Date.UTC(2026, 9, 24, 22, 0, 0); // 2026-10-25 00:00 Oslo (UTC+2)
    const sampleUtcEnd = Date.UTC(2026, 9, 25, 22, 0, 0);   // 2026-10-25 23:00 Oslo (UTC+1 by then)

    const buckets: Record<string, number> = {};
    for (let ts = sampleUtcStart; ts <= sampleUtcEnd; ts += 60 * 60 * 1000) {
      buckets[isoHour(ts)] = 0.1;
    }

    const now = sampleUtcEnd + HOURLY_RETENTION_MS + 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);

    const pruned = aggregateAndPruneHistory({ buckets }, { timeZone: OSLO });

    const total = Object.values(pruned.dailyTotals ?? {}).reduce((acc, v) => acc + v, 0);
    expect(total).toBeCloseTo(Object.values(buckets).reduce((acc, v) => acc + v, 0), 6);
    // 25 samples should all land on 2026-10-25 local = 2.5 kWh.
    expect(pruned.dailyTotals?.['2026-10-25']).toBeCloseTo(2.5, 6);
  });

  it('falls back to UTC date keys when no timezone is supplied (back-compat)', () => {
    // Same boundary sample as the first case: UTC-keyed code attributes it to 2026-01-15.
    const sampleUtcMs = Date.UTC(2026, 0, 15, 23, 0, 0);
    const now = sampleUtcMs + HOURLY_RETENTION_MS + 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);

    const pruned = aggregateAndPruneHistory({ buckets: { [isoHour(sampleUtcMs)]: 1.5 } });

    expect(pruned.dailyTotals).toEqual({ '2026-01-15': 1.5 });
  });
});

describe('aggregateAndPruneHistory — local hour-of-day for hourlyAverages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attributes a sample to the Oslo-local hour-of-day, not the UTC hour', () => {
    // 2026-01-16 00:30 Oslo = 2026-01-15 23:30 UTC. Local hour-of-day must be 0.
    // (UTC-keyed code would record this at hour 23.)
    const sampleUtcMs = Date.UTC(2026, 0, 15, 23, 0, 0);
    const now = sampleUtcMs + HOURLY_RETENTION_MS + 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);

    const pruned = aggregateAndPruneHistory(
      { buckets: { [isoHour(sampleUtcMs)]: 1 } },
      { timeZone: OSLO },
    );

    // 2026-01-16 was a Friday (dayOfWeek=5).
    const fridayHour0 = pruned.hourlyAverages?.['5_0'];
    expect(fridayHour0).toBeDefined();
    expect(fridayHour0?.sum).toBeCloseTo(1, 6);
    expect(fridayHour0?.count).toBe(1);
    // Conversely, the UTC-hour bucket (hour 23, Thursday=4) must be empty.
    expect(pruned.hourlyAverages?.['4_23']).toBeUndefined();
  });
});
