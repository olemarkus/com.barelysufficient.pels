import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';

const OSLO = 'Europe/Oslo';

// Oslo (UTC+1 in winter): local day 2026-01-10 spans
// [2026-01-09T23:00Z, 2026-01-10T23:00Z).
describe('resolveDailyKwh', () => {
  it('sums hourly buckets over the local-day window (recent days)', () => {
    const result = resolveDailyKwh({
      dateKey: '2026-01-10',
      timeZone: OSLO,
      source: {
        buckets: {
          '2026-01-09T22:00:00.000Z': 9, // local 2026-01-09 — excluded
          '2026-01-09T23:00:00.000Z': 1.5, // local midnight hour — included
          '2026-01-10T11:00:00.000Z': 2,
          '2026-01-10T22:00:00.000Z': 0.5, // local 23:00 — included
          '2026-01-10T23:00:00.000Z': 99, // local 2026-01-11 — excluded
        },
        controlledBuckets: {
          '2026-01-10T11:00:00.000Z': 1.25,
        },
      },
    });
    expect(result).toEqual({ total: 4, controlled: 1.25 });
  });

  it('falls back to dailyTotals when no buckets cover the day (older than hourly retention)', () => {
    const result = resolveDailyKwh({
      dateKey: '2025-06-01',
      timeZone: OSLO,
      source: {
        buckets: { '2026-01-10T11:00:00.000Z': 2 },
        dailyTotals: { '2025-06-01': 30 },
        controlledDailyTotals: { '2025-06-01': 12 },
      },
    });
    expect(result).toEqual({ total: 30, controlled: 12 });
  });

  it('returns an empty result when neither source covers the day', () => {
    expect(resolveDailyKwh({ dateKey: '2025-06-01', timeZone: OSLO, source: {} })).toEqual({});
  });

  it('sums both sources for the day straddling the tracker prune boundary', () => {
    // Pruning MOVES aged hours from buckets into dailyTotals one by one, so a
    // half-pruned day legitimately has energy in both places — disjoint.
    const result = resolveDailyKwh({
      dateKey: '2026-01-10',
      timeZone: OSLO,
      source: {
        buckets: { '2026-01-10T11:00:00.000Z': 2 },
        dailyTotals: { '2026-01-10': 30 },
      },
    });
    expect(result).toEqual({ total: 32 });
  });
});
