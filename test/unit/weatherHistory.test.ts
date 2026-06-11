import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  applyActualSample,
  applyForecastSample,
  emptyWeatherHistoryState,
  normalizeWeatherHistoryState,
  periodsOverlapWindow,
  rollupDay,
  upsertBackfillRecords,
  WEATHER_HISTORY_RETENTION_DAYS,
} from '../../lib/weather/weatherHistory';
import { shiftDateKey } from '../../lib/utils/dateUtils';

const liveRecord = (dateKey: string, overrides: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  dateKey,
  kwhTotal: 40,
  tempMeanC: 2,
  tempMinC: -1,
  tempMaxC: 5,
  tempSampleCount: 24,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
  ...overrides,
});

const backfilledRecord = (dateKey: string, overrides: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  ...liveRecord(dateKey),
  tempSampleCount: 4,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
  ...overrides,
});

describe('applyActualSample', () => {
  it('accumulates mean/min/max per day', () => {
    let state = emptyWeatherHistoryState();
    state = applyActualSample(state, { dateKey: '2026-01-10', hourKey: '08', temperatureC: -4 });
    state = applyActualSample(state, { dateKey: '2026-01-10', hourKey: '09', temperatureC: 2 });
    expect(state.accumulators?.['2026-01-10']).toMatchObject({
      sumC: -2, count: 2, minC: -4, maxC: 2, lastHourKey: '09',
    });
  });

  it('drops a second sample landing in the same local hour (restart re-sample)', () => {
    let state = emptyWeatherHistoryState();
    state = applyActualSample(state, { dateKey: '2026-01-10', hourKey: '08', temperatureC: -4 });
    state = applyActualSample(state, { dateKey: '2026-01-10', hourKey: '08', temperatureC: -3 });
    expect(state.accumulators?.['2026-01-10']?.count).toBe(1);
  });

  it('keeps separate accumulators per day across midnight before rollup', () => {
    let state = emptyWeatherHistoryState();
    state = applyActualSample(state, { dateKey: '2026-01-10', hourKey: '23', temperatureC: -4 });
    state = applyActualSample(state, { dateKey: '2026-01-11', hourKey: '00', temperatureC: -5 });
    expect(Object.keys(state.accumulators ?? {})).toEqual(['2026-01-10', '2026-01-11']);
  });
});

describe('applyForecastSample', () => {
  it('stores readings under the target day and hour, ignoring non-future targets', () => {
    let state = emptyWeatherHistoryState();
    state = applyForecastSample(state, {
      targetDateKey: '2026-01-11', hourKey: '14', temperatureC: -2, todayKey: '2026-01-10',
    });
    state = applyForecastSample(state, {
      targetDateKey: '2026-01-10', hourKey: '15', temperatureC: 9, todayKey: '2026-01-10',
    });
    expect(state.forecastHourly).toEqual({ '2026-01-11': { '14': -2 } });
  });

  it('retains at most two future target days', () => {
    let state = emptyWeatherHistoryState();
    for (const target of ['2026-01-11', '2026-01-12', '2026-01-13']) {
      state = applyForecastSample(state, {
        targetDateKey: target, hourKey: '00', temperatureC: 0, todayKey: '2026-01-10',
      });
    }
    expect(Object.keys(state.forecastHourly ?? {}).sort()).toEqual(['2026-01-11', '2026-01-12']);
  });
});

describe('rollupDay', () => {
  const baseState = (): WeatherHistoryState => applyActualSampleTimes(emptyWeatherHistoryState(), 20);

  const applyActualSampleTimes = (state: WeatherHistoryState, count: number): WeatherHistoryState => {
    let next = state;
    for (let hour = 0; hour < count; hour += 1) {
      next = applyActualSample(next, {
        dateKey: '2026-01-10',
        hourKey: String(hour).padStart(2, '0'),
        temperatureC: hour % 2 === 0 ? -2 : 2,
      });
    }
    return next;
  };

  it('finalizes the accumulator into a record with kWh snapshot and quality flags', () => {
    const state = rollupDay(baseState(), {
      dateKey: '2026-01-10', dayLengthHours: 24, kwhTotal: 42.5, kwhControlled: 11, unreliablePower: false,
    });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({
      dateKey: '2026-01-10',
      kwhTotal: 42.5,
      kwhControlled: 11,
      tempMeanC: 0,
      tempMinC: -2,
      tempMaxC: 2,
      tempSampleCount: 20,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
    });
    expect(state.accumulators?.['2026-01-10']).toBeUndefined();
  });

  it('flags partial temperature coverage and missing kWh', () => {
    let state = emptyWeatherHistoryState();
    state = applyActualSample(state, { dateKey: '2026-01-10', hourKey: '08', temperatureC: 1 });
    state = rollupDay(state, { dateKey: '2026-01-10', dayLengthHours: 24, unreliablePower: true });
    expect(state.records[0].quality).toEqual({
      partialTemp: true, missingKwh: true, unreliablePower: true, backfilled: false,
    });
    expect(state.records[0].kwhTotal).toBeUndefined();
  });

  it('replaces a backfilled record but never an existing live record', () => {
    const seeded: WeatherHistoryState = {
      ...baseState(),
      records: [backfilledRecord('2026-01-10', { tempMeanC: 99 })],
    };
    const afterLive = rollupDay(seeded, {
      dateKey: '2026-01-10', dayLengthHours: 24, kwhTotal: 40, unreliablePower: false,
    });
    expect(afterLive.records[0].quality.backfilled).toBe(false);
    expect(afterLive.records[0].tempMeanC).toBe(0);

    const reRolled = rollupDay(
      applyActualSampleTimes(afterLive, 5),
      { dateKey: '2026-01-10', dayLengthHours: 24, kwhTotal: 1, unreliablePower: false },
    );
    expect(reRolled.records[0].kwhTotal).toBe(40);
  });

  it('prunes records beyond the retention window', () => {
    const ancient = liveRecord(shiftDateKey('2026-01-10', -(WEATHER_HISTORY_RETENTION_DAYS + 1)));
    const state = rollupDay(
      { ...baseState(), records: [ancient] },
      { dateKey: '2026-01-10', dayLengthHours: 24, kwhTotal: 40, unreliablePower: false },
    );
    expect(state.records.map((record) => record.dateKey)).toEqual(['2026-01-10']);
  });

  it('drops stale forecast days and old accumulators', () => {
    let state = baseState();
    state = applyForecastSample(state, {
      targetDateKey: '2026-01-11', hourKey: '10', temperatureC: 0, todayKey: '2026-01-10',
    });
    state = {
      ...state,
      accumulators: { ...state.accumulators, '2026-01-05': { sumC: 1, count: 1, minC: 1, maxC: 1 } },
      forecastHourly: { ...state.forecastHourly, '2026-01-09': { '01': 5 } },
    };
    state = rollupDay(state, {
      dateKey: '2026-01-10', dayLengthHours: 24, kwhTotal: 40, unreliablePower: false,
    });
    expect(state.accumulators?.['2026-01-05']).toBeUndefined();
    expect(Object.keys(state.forecastHourly ?? {})).toEqual(['2026-01-11']);
  });
});

describe('upsertBackfillRecords', () => {
  it('inserts sorted, refreshes backfilled entries, and never overwrites live records', () => {
    const state: WeatherHistoryState = {
      records: [liveRecord('2026-01-08', { tempMeanC: 4 }), backfilledRecord('2026-01-06', { tempMeanC: 1 })],
    };
    const next = upsertBackfillRecords(state, [
      backfilledRecord('2026-01-05'),
      backfilledRecord('2026-01-06', { tempMeanC: -7 }),
      backfilledRecord('2026-01-08', { tempMeanC: -7 }),
    ]);
    expect(next.records.map((record) => record.dateKey)).toEqual(['2026-01-05', '2026-01-06', '2026-01-08']);
    expect(next.records[1].tempMeanC).toBe(-7);
    expect(next.records[2].tempMeanC).toBe(4);
  });
});

describe('periodsOverlapWindow', () => {
  it('detects any overlap with the window', () => {
    expect(periodsOverlapWindow([{ start: 0, end: 5 }], 4, 10)).toBe(true);
    expect(periodsOverlapWindow([{ start: 10, end: 12 }], 4, 10)).toBe(false);
    expect(periodsOverlapWindow([], 4, 10)).toBe(false);
  });
});

describe('normalizeWeatherHistoryState', () => {
  it('returns null for absent or structurally hopeless payloads', () => {
    expect(normalizeWeatherHistoryState(undefined)).toBeNull();
    expect(normalizeWeatherHistoryState(null)).toBeNull();
    expect(normalizeWeatherHistoryState('garbage')).toBeNull();
    expect(normalizeWeatherHistoryState({ records: 'nope' })).toBeNull();
  });

  it('round-trips a valid state and drops malformed entries', () => {
    const valid: WeatherHistoryState = {
      records: [liveRecord('2026-01-09'), liveRecord('2026-01-08')],
      accumulators: { '2026-01-10': { sumC: 3, count: 2, minC: 1, maxC: 2, lastHourKey: '09' } },
      forecastHourly: { '2026-01-11': { '14': -2 } },
      backfilledDeviceId: 'dev-1',
    };
    const withJunk = {
      ...valid,
      records: [...valid.records, { dateKey: 'bad' }, 42],
      accumulators: { ...valid.accumulators, 'not-a-date': { sumC: 1, count: 1, minC: 1, maxC: 1 } },
      forecastHourly: { ...valid.forecastHourly, '2026-01-12': { '99': 5, '07': 200 } },
    };
    const normalized = normalizeWeatherHistoryState(JSON.parse(JSON.stringify(withJunk)));
    expect(normalized).toEqual({
      ...valid,
      // Sorted ascending; junk dropped.
      records: [liveRecord('2026-01-08'), liveRecord('2026-01-09')],
    });
  });

  it('keeps records its own writer can produce: negative kWh (net export) must not drop the day', () => {
    const exportDay = liveRecord('2026-01-09', { kwhTotal: -3.2 });
    const normalized = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({ records: [exportDay] })));
    expect(normalized?.records).toEqual([exportDay]);
  });

  it('rejects non-finite counts that JSON would corrupt', () => {
    const broken = { ...liveRecord('2026-01-09'), tempSampleCount: Number.POSITIVE_INFINITY };
    const normalized = normalizeWeatherHistoryState({ records: [broken] });
    expect(normalized?.records).toEqual([]);
  });
});
