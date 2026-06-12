import { fetchDailyConsumedKwh, listMonthKeys } from '../../lib/weather/energyReportBackfill';

const monthReport = (days: Record<string, number | null>) => ({
  subReports: Object.fromEntries(
    Object.entries(days).map(([dateKey, consumed]) => [dateKey, {
      electricity: { consumedPeriod: consumed, importedPeriod: null },
      gas: { importedPeriod: null },
    }]),
  ),
});

describe('listMonthKeys', () => {
  it('spans inclusive months across a year boundary', () => {
    expect(listMonthKeys('2025-11-20', '2026-02-03')).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02',
    ]);
  });

  it('returns a single month for a same-month range and [] for malformed keys', () => {
    expect(listMonthKeys('2026-03-03', '2026-03-31')).toEqual(['2026-03']);
    expect(listMonthKeys('garbage', '2026-03-31')).toEqual([]);
  });
});

describe('fetchDailyConsumedKwh', () => {
  it('collects plausible consumed days and skips nulls and implausible values', async () => {
    const fetchFromHomeyApi = vi.fn(async () => monthReport({
      '2025-03-01': 39.21,
      '2025-03-02': null,
      '2025-03-03': 0,
      '2025-03-04': 1500,
      '2025-03-05': 28.4,
    }));
    const result = await fetchDailyConsumedKwh({ monthKeys: ['2025-03'], fetchFromHomeyApi });
    expect(result).toEqual({
      dailyKwh: { '2025-03-01': 39.21, '2025-03-05': 28.4 },
      complete: true,
    });
  });

  it('treats missing months (404) as empty success, other failures as incomplete', async () => {
    const fetchFromHomeyApi = vi.fn(async (path: string) => {
      if (path.includes('2024-12')) throw new Error('HTTP 404: Not Found: EnergyReportMonth');
      if (path.includes('2025-02')) throw new Error('HTTP 500: boom');
      return monthReport({ '2025-01-20': 31 });
    });
    const result = await fetchDailyConsumedKwh({
      monthKeys: ['2024-12', '2025-01', '2025-02'],
      fetchFromHomeyApi,
    });
    expect(result.dailyKwh).toEqual({ '2025-01-20': 31 });
    expect(result.complete).toBe(false);
  });
});
