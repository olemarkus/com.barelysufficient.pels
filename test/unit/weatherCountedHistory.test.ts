import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { recoverCountedHistory } from '../../lib/weather/weatherCountedHistory';

const day = (dateKey: string): WeatherDailyRecord => ({
  dateKey, kwhTotal: 60, tempMeanC: 5, tempMinC: 3, tempMaxC: 7, tempSampleCount: 24,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
});

describe('counted weather history recovery', () => {
  it('recovers retained accounting evidence despite completed backfill markers', () => {
    const state: WeatherHistoryState = {
      records: [day('2026-11-01')], meterKwhBackfillDone: true, controlledBackfillVersion: 2,
    };
    const next = recoverCountedHistory(state, () => ({ total: 60, budgetCounted: 40 }));
    expect(next.records[0]).toMatchObject({ kwhTotal: 60, kwhBudgetCounted: 40 });
    expect(state.records[0].kwhBudgetCounted).toBeUndefined();
  });

  it('does not infer exemption from a total-only read or join different meter totals', () => {
    const state = { records: [day('2026-11-01')] };
    expect(recoverCountedHistory(state, () => ({ total: 60 }))).toBe(state);
    expect(recoverCountedHistory(state, () => ({ total: 61, budgetCounted: 40 }))).toBe(state);
  });

  it('honors the meter-scope transition and preserves accepted counted history', () => {
    const state: WeatherHistoryState = {
      meterScopeSinceDateKey: '2026-11-02',
      records: [day('2026-11-01'), { ...day('2026-11-03'), kwhBudgetCounted: 40 }],
    };
    const readDay = vi.fn(() => ({ total: 60, budgetCounted: 60 }));
    expect(recoverCountedHistory(state, readDay)).toBe(state);
    expect(readDay).not.toHaveBeenCalled();
  });

  it('bounds recovery reads to the latest 31 records', () => {
    const records = Array.from({ length: 100 }, (_, index) => day(String(index)));
    const readDay = vi.fn(() => ({}));
    const state = { records };
    expect(recoverCountedHistory(state, readDay)).toBe(state);
    expect(readDay).toHaveBeenCalledTimes(31);
  });
});
