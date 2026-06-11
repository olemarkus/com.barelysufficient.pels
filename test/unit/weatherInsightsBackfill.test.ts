import { fetchBackfillDailyRecords } from '../../lib/weather/weatherInsightsBackfill';

const OSLO = 'Europe/Oslo';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 10, 12, 0, 0);

type EntryPoint = { t: string; v: number | null };

const sixHourPoints = (utcDayMs: number, temps: Array<number | null>): EntryPoint[] => temps.map(
  (v, index) => ({ t: new Date(utcDayMs + index * SIX_HOURS_MS).toISOString(), v }),
);

const entryResponse = (values: EntryPoint[], step = SIX_HOURS_MS) => ({ step, values });

describe('fetchBackfillDailyRecords', () => {
  it('stitches resolutions, dedupes by timestamp, and builds per-local-day records', async () => {
    // 2026-01-05 in Oslo (UTC+1) starts at 2026-01-04T23:00Z.
    const day5StartUtc = Date.UTC(2026, 0, 4, 23, 0, 0);
    const day6StartUtc = Date.UTC(2026, 0, 5, 23, 0, 0);
    const lastYear = entryResponse([
      ...sixHourPoints(day5StartUtc, [-4, -2, 0, -6]),
      ...sixHourPoints(day6StartUtc, [1, 3, null, 5]),
    ]);
    // Overlapping window re-reports day 6 — same timestamps must not double-count.
    const last31Days = entryResponse(sixHourPoints(day6StartUtc, [1, 3, null, 5]));

    const fetchInsights = vi.fn(async (path: string) => {
      expect(path).toContain(
        'manager/insights/log/homey:device:dev-1/homey:device:dev-1:measure_temperature/entry',
      );
      if (path.includes('lastYear')) return lastYear;
      if (path.includes('last3Months')) throw new Error('transient');
      return last31Days;
    });

    const { records, complete } = await fetchBackfillDailyRecords({
      deviceId: 'dev-1',
      fetchInsights,
      getDailyKwh: (dateKey) => (dateKey === '2026-01-05' ? { total: 52, controlled: 9 } : {}),
      timeZone: OSLO,
      nowMs: NOW_MS,
    });

    // One resolution threw, so the run must not count as complete.
    expect(complete).toBe(false);
    expect(records).toEqual([
      {
        dateKey: '2026-01-05',
        kwhTotal: 52,
        kwhControlled: 9,
        tempMeanC: -3,
        tempMinC: -6,
        tempMaxC: 0,
        tempSampleCount: 4,
        quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
      },
      {
        dateKey: '2026-01-06',
        tempMeanC: 3,
        tempMinC: 1,
        tempMaxC: 5,
        tempSampleCount: 3,
        quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
      },
    ]);
  });

  it('skips days with fewer than three points and anything from today onward', async () => {
    const todayStartUtc = Date.UTC(2026, 0, 9, 23, 0, 0);
    const sparseDayUtc = Date.UTC(2026, 0, 2, 23, 0, 0);
    const fetchInsights = vi.fn(async () => entryResponse([
      ...sixHourPoints(todayStartUtc, [0, 1, 2, 3]),
      ...sixHourPoints(sparseDayUtc, [4, null, null, null]),
    ]));
    const { records, complete } = await fetchBackfillDailyRecords({
      deviceId: 'dev-1', fetchInsights, getDailyKwh: () => ({}), timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(records).toEqual([]);
    expect(complete).toBe(true);
  });

  it('ignores responses coarser than six hours', async () => {
    const weekStep = entryResponse(
      sixHourPoints(Date.UTC(2026, 0, 1, 23, 0, 0), [1, 2, 3, 4]),
      7 * 24 * 60 * 60 * 1000,
    );
    const fetchInsights = vi.fn(async () => weekStep);
    const { records } = await fetchBackfillDailyRecords({
      deviceId: 'dev-1', fetchInsights, getDailyKwh: () => ({}), timeZone: OSLO, nowMs: NOW_MS,
    });
    expect(records).toEqual([]);
  });

  it('throws when every resolution fails', async () => {
    const fetchInsights = vi.fn(async () => {
      throw new Error('insights unavailable');
    });
    await expect(fetchBackfillDailyRecords({
      deviceId: 'dev-1', fetchInsights, getDailyKwh: () => ({}), timeZone: OSLO, nowMs: NOW_MS,
    })).rejects.toThrow('insights unavailable');
  });
});
