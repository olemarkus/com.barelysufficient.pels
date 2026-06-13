import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  applyActualSample,
  applyControlledBackfill,
  mergeRecoveredState,
  applyForecastSample,
  emptyWeatherHistoryState,
  normalizeWeatherHistoryState,
  periodsOverlapWindow,
  reconcileKwhSources,
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

  it('records the uncontrolled split and a non-empty suppression covariate', () => {
    const state = rollupDay(baseState(), {
      dateKey: '2026-01-10',
      dayLengthHours: 24,
      kwhTotal: 42.5,
      kwhControlled: 11,
      kwhUncontrolled: 31.5,
      unreliablePower: false,
      suppression: { targetDeficitMs: 7_200_000, deadlineMissedToBudget: true },
    });
    expect(state.records[0]).toMatchObject({
      kwhUncontrolled: 31.5,
      suppression: { targetDeficitMs: 7_200_000, deadlineMissedToBudget: true },
    });
  });

  it('omits an all-empty suppression object so absent stays "unknown"', () => {
    const state = rollupDay(baseState(), {
      dateKey: '2026-01-10', dayLengthHours: 24, kwhTotal: 42.5, unreliablePower: false, suppression: {},
    });
    expect(state.records[0].suppression).toBeUndefined();
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

  it('carries the kWh layer onto a refreshed record that arrives without one', () => {
    const meterFilled = backfilledRecord('2026-01-06', {
      kwhTotal: 38.5,
      quality: {
        partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true,
      },
    });
    const freshTempOnly = backfilledRecord('2026-01-06', {
      tempMeanC: -7,
      kwhTotal: undefined,
      quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
    });
    const next = upsertBackfillRecords({ records: [meterFilled] }, [freshTempOnly]);
    expect(next.records[0]).toMatchObject({
      tempMeanC: -7,
      kwhTotal: 38.5,
      quality: { missingKwh: false, kwhBackfilled: true },
    });
  });
});

describe('reconcileKwhSources', () => {
  const trackerByDay: Record<string, { total?: number; controlled?: number }> = {
    '2026-03-05': { total: 44, controlled: 12 },
  };
  const getDailyKwh = (dateKey: string): { total?: number; controlled?: number } => trackerByDay[dateKey] ?? {};

  it('preserves the suppression covariate and refreshes the uncontrolled split on a tracker win', () => {
    const live = liveRecord('2026-03-05', {
      kwhTotal: 40, kwhControlled: 8, kwhUncontrolled: 30, suppression: { targetDeficitMs: 3_600_000 },
    });
    const getKwh = (dateKey: string): { total?: number; controlled?: number; uncontrolled?: number } => (
      dateKey === '2026-03-05' ? { total: 44, controlled: 12, uncontrolled: 31 } : {}
    );
    const { state } = reconcileKwhSources(
      { records: [live] },
      { getDailyKwh: getKwh, meterDailyKwh: {}, allowStrip: true },
    );
    expect(state.records[0]).toMatchObject({
      kwhTotal: 44, kwhControlled: 12, kwhUncontrolled: 31, suppression: { targetDeficitMs: 3_600_000 },
    });
  });

  it('drops a stale controlled/uncontrolled split when the tracker total has no fresh split', () => {
    const live = liveRecord('2026-03-05', { kwhTotal: 40, kwhControlled: 8, kwhUncontrolled: 30 });
    // Tracker has a real total for the day but no controlled/uncontrolled split.
    const getKwh = (dateKey: string): { total?: number; controlled?: number; uncontrolled?: number } => (
      dateKey === '2026-03-05' ? { total: 44 } : {}
    );
    const { state } = reconcileKwhSources(
      { records: [live] },
      { getDailyKwh: getKwh, meterDailyKwh: {}, allowStrip: true },
    );
    expect(state.records[0].kwhTotal).toBe(44);
    expect(state.records[0].kwhControlled).toBeUndefined();
    expect(state.records[0].kwhUncontrolled).toBeUndefined();
  });

  it('applies the trust ladder: tracker wins, meter fills, unvalidated backfilled kWh is stripped', () => {
    const missing = backfilledRecord('2025-02-01', {
      kwhTotal: undefined,
      quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
    });
    // Contaminated: an unvalidated legacy source wrote kWh (and a stale
    // controlled split) the meter does not cover.
    const contaminated = backfilledRecord('2025-02-02', { kwhTotal: 19.5, kwhControlled: 5 });
    // Legacy kWh the meter DOES cover is overwritten — and the foreign
    // controlled split must not survive next to the fresh total.
    const overwritten = backfilledRecord('2025-02-03', { kwhTotal: 17, kwhControlled: 4 });
    const joined = liveRecord('2026-03-05', { kwhTotal: 43, kwhControlled: 10 });
    const { state, filledFromMeter, strippedDays, changedDays } = reconcileKwhSources(
      { records: [missing, contaminated, overwritten, joined] },
      {
        getDailyKwh,
        meterDailyKwh: { '2025-02-01': 52.3, '2025-02-03': 41.2, '2026-03-05': 999 },
        allowStrip: true,
      },
    );
    expect(state.records[0]).toMatchObject({
      kwhTotal: 52.3,
      quality: { missingKwh: false, backfilled: true, kwhBackfilled: true },
    });
    expect(state.records[1].kwhTotal).toBeUndefined();
    expect(state.records[1].kwhControlled).toBeUndefined();
    expect(state.records[1].quality.missingKwh).toBe(true);
    expect(state.records[2].kwhTotal).toBe(41.2);
    expect(state.records[2].kwhControlled).toBeUndefined();
    // Tracker outranks the (implausible) meter value on the day it covers.
    expect(state.records[3]).toMatchObject({ kwhTotal: 44, kwhControlled: 12 });
    expect({ filledFromMeter, strippedDays, changedDays }).toEqual({
      filledFromMeter: 2, strippedDays: 1, changedDays: 4,
    });
  });

  it('fills but never strips on a partial run (allowStrip=false)', () => {
    const missing = backfilledRecord('2025-02-01', {
      kwhTotal: undefined,
      quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
    });
    const contaminated = backfilledRecord('2025-02-02', { kwhTotal: 19.5 });
    const { state, strippedDays } = reconcileKwhSources(
      { records: [missing, contaminated] },
      { getDailyKwh, meterDailyKwh: { '2025-02-01': 52.3 }, allowStrip: false },
    );
    expect(state.records[0].kwhTotal).toBe(52.3);
    expect(state.records[1].kwhTotal).toBe(19.5);
    expect(strippedDays).toBe(0);
  });

  it('never strips or overwrites a live day-close snapshot the tracker has since forgotten', () => {
    const agedLive = liveRecord('2024-06-01', { kwhTotal: 31 });
    // Even when the meter covers the day: the snapshot WAS the tracker.
    const { state, changedDays } = reconcileKwhSources(
      { records: [agedLive] },
      { getDailyKwh, meterDailyKwh: { '2024-06-01': 29.5 }, allowStrip: true },
    );
    expect(changedDays).toBe(0);
    expect(state.records[0].kwhTotal).toBe(31);
  });

  it('keeps validated meter fills that aged beyond the sources, and refreshes covered ones', () => {
    const meterFilled = liveRecord('2024-06-01', {
      kwhTotal: 29.5,
      quality: {
        partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false, kwhBackfilled: true,
      },
    });
    // No source reaches the day anymore — the fill was validated against the
    // tracker when written, so it stays (a bad read must never delete it).
    const kept = reconcileKwhSources(
      { records: [meterFilled] },
      { getDailyKwh, meterDailyKwh: {}, allowStrip: true },
    );
    expect(kept.changedDays).toBe(0);
    expect(kept.state.records[0].kwhTotal).toBe(29.5);
    // Where the current map covers it, the value is re-resolved.
    const refreshed = reconcileKwhSources(
      { records: [meterFilled] },
      { getDailyKwh, meterDailyKwh: { '2024-06-01': 30.1 }, allowStrip: true },
    );
    expect(refreshed.state.records[0].kwhTotal).toBe(30.1);
    expect(refreshed.state.records[0].quality.kwhBackfilled).toBe(true);
  });

  it('treats a zero tracker total as no measurement, not authority', () => {
    const meterFilled = backfilledRecord('2026-03-06', {
      kwhTotal: 38,
      quality: {
        partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true,
      },
    });
    const zeroTracker = (dateKey: string): { total?: number } => (dateKey === '2026-03-06' ? { total: 0 } : {});
    const { state, changedDays } = reconcileKwhSources(
      { records: [meterFilled] },
      { getDailyKwh: zeroTracker, meterDailyKwh: { '2026-03-06': 38 }, allowStrip: true },
    );
    expect(changedDays).toBe(0);
    expect(state.records[0].kwhTotal).toBe(38);
  });

  it('is an identity when every record already matches its source', () => {
    const original = {
      records: [
        liveRecord('2026-03-05', { kwhTotal: 44, kwhControlled: 12 }),
        backfilledRecord('2025-02-01', {
          kwhTotal: 52.3,
          quality: {
            partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true,
          },
        }),
      ],
    };
    const { state, changedDays } = reconcileKwhSources(
      original,
      { getDailyKwh, meterDailyKwh: { '2025-02-01': 52.3 }, allowStrip: true },
    );
    expect(changedDays).toBe(0);
    expect(state).toBe(original);
  });
});

describe('mergeRecoveredState markers', () => {
  it('keeps only RECOVERED meter markers — an in-memory completion may predate the superset', () => {
    const base = { records: [liveRecord('2026-01-08')] };
    const inMemoryDone = mergeRecoveredState(
      base,
      { records: [], meterKwhBackfillDone: true, meterKwhDeviceId: 'meter-1' },
    );
    expect(inMemoryDone.meterKwhBackfillDone).toBeUndefined();
    expect(inMemoryDone.meterKwhDeviceId).toBeUndefined();
    const recoveredDone = mergeRecoveredState(
      { ...base, meterKwhBackfillDone: true, meterKwhDeviceId: 'meter-1' },
      { records: [] },
    );
    expect(recoveredDone.meterKwhBackfillDone).toBe(true);
    expect(recoveredDone.meterKwhDeviceId).toBe('meter-1');
  });

  it('keeps only a RECOVERED controlled-split marker', () => {
    const base = { records: [liveRecord('2026-01-08')] };
    expect(mergeRecoveredState(base, { records: [], controlledBackfillVersion: 1 }).controlledBackfillVersion)
      .toBeUndefined();
    expect(mergeRecoveredState({ ...base, controlledBackfillVersion: 1 }, { records: [] }).controlledBackfillVersion)
      .toBe(1);
  });

  it('carries the temp backfill version with its deviceId as a pair', () => {
    const recovered = { records: [], backfilledDeviceId: 'dev-old', backfillVersion: 1 };
    const inMemory = { records: [], backfilledDeviceId: 'dev-new', backfillVersion: 2 };
    const merged = mergeRecoveredState(recovered, inMemory);
    expect(merged).toMatchObject({ backfilledDeviceId: 'dev-old', backfillVersion: 1 });
    const noRecoveredMarker = mergeRecoveredState({ records: [] }, inMemory);
    expect(noRecoveredMarker).toMatchObject({ backfilledDeviceId: 'dev-new', backfillVersion: 2 });
  });

  it('keeps the live auto-apply audit, falling back to recovered when in-memory has none', () => {
    const inMemoryAudit = { dateKey: '2026-01-09', kwh: 44, appliedAtMs: 2 };
    const recoveredAudit = { dateKey: '2026-01-08', kwh: 40, appliedAtMs: 1 };
    // Live (in-memory) audit wins.
    expect(mergeRecoveredState(
      { records: [], lastAutoApply: recoveredAudit },
      { records: [], lastAutoApply: inMemoryAudit },
    ).lastAutoApply).toEqual(inMemoryAudit);
    // Falls back to recovered when in-memory has none.
    expect(mergeRecoveredState(
      { records: [], lastAutoApply: recoveredAudit },
      { records: [] },
    ).lastAutoApply).toEqual(recoveredAudit);
  });
});

describe('periodsOverlapWindow', () => {
  it('detects any overlap with the window', () => {
    expect(periodsOverlapWindow([{ start: 0, end: 5 }], 4, 10)).toBe(true);
    expect(periodsOverlapWindow([{ start: 10, end: 12 }], 4, 10)).toBe(false);
    expect(periodsOverlapWindow([], 4, 10)).toBe(false);
  });
});

describe('applyControlledBackfill', () => {
  const meterDay = (dateKey: string, kwhTotal: number): WeatherDailyRecord => backfilledRecord(dateKey, {
    kwhTotal,
    quality: {
      partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true,
    },
  });

  it('fills the split on a meter-backfilled day (kwhTotal, no split)', () => {
    const { state, patchedDays } = applyControlledBackfill(
      { records: [meterDay('2025-02-01', 50)] },
      { '2025-02-01': 18 },
    );
    expect(patchedDays).toBe(1);
    expect(state.records[0]).toMatchObject({ kwhTotal: 50, kwhControlled: 18, kwhUncontrolled: 32 });
  });

  it('clamps controlled into [0, total] (a noisy over-estimate cannot make uncontrolled negative)', () => {
    const { state } = applyControlledBackfill({ records: [meterDay('2025-02-01', 30)] }, { '2025-02-01': 41 });
    expect(state.records[0]).toMatchObject({ kwhControlled: 30, kwhUncontrolled: 0 });
  });

  it('never overwrites a live-rollup split or a day with no whole-home total', () => {
    const live = liveRecord('2026-03-05', { kwhTotal: 44, kwhControlled: 12, kwhUncontrolled: 30 });
    const missing = backfilledRecord('2025-02-02', {
      kwhTotal: undefined,
      quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
    });
    const { state, patchedDays } = applyControlledBackfill(
      { records: [live, missing] },
      { '2026-03-05': 5, '2025-02-02': 9 },
    );
    expect(patchedDays).toBe(0);
    expect(state.records[0]).toMatchObject({ kwhControlled: 12, kwhUncontrolled: 30 });
    expect(state.records[1].kwhControlled).toBeUndefined();
  });

  it('is an identity when no covered day matches', () => {
    const original = { records: [meterDay('2025-02-01', 50)] };
    const { state, patchedDays } = applyControlledBackfill(original, { '2020-01-01': 10 });
    expect(patchedDays).toBe(0);
    expect(state).toBe(original);
  });

  it('refreshes a backfilled split (a later complete run corrects an earlier partial undercount)', () => {
    // A prior partial run wrote an undercounted controlled value (5 of 50).
    const partial = meterDay('2025-02-01', 50);
    const seeded = { records: [{ ...partial, kwhControlled: 5, kwhUncontrolled: 45 }] };
    const { state, patchedDays } = applyControlledBackfill(seeded, { '2025-02-01': 18 });
    expect(patchedDays).toBe(1);
    expect(state.records[0]).toMatchObject({ kwhControlled: 18, kwhUncontrolled: 32 });
  });

  it('is a no-op (no patch) when the backfilled split already matches', () => {
    const seeded = { records: [{ ...meterDay('2025-02-01', 50), kwhControlled: 18, kwhUncontrolled: 32 }] };
    const { state, patchedDays } = applyControlledBackfill(seeded, { '2025-02-01': 18 });
    expect(patchedDays).toBe(0);
    expect(state).toBe(seeded);
  });

  it('leaves a net-export day (negative whole-home total) unsplit — no negative controlled', () => {
    const exportDay = meterDay('2025-02-01', -4.2);
    const { state, patchedDays } = applyControlledBackfill({ records: [exportDay] }, { '2025-02-01': 18 });
    expect(patchedDays).toBe(0);
    expect(state.records[0].kwhControlled).toBeUndefined();
    expect(state.records[0].kwhUncontrolled).toBeUndefined();
  });

  it('derives uncontrolled from the authoritative tracker controlled on a tracker-join day, never overwriting it', () => {
    // Temp-backfill tracker-join: kwhControlled from the tracker, no kwhBackfilled flag, no uncontrolled yet.
    const trackerJoin = backfilledRecord('2026-02-10', {
      kwhTotal: 50,
      kwhControlled: 22,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
    });
    // The meter sum (19) must NOT replace the tracker's 22; only uncontrolled is derived.
    const { state, patchedDays } = applyControlledBackfill({ records: [trackerJoin] }, { '2026-02-10': 19 });
    expect(patchedDays).toBe(1);
    expect(state.records[0]).toMatchObject({ kwhControlled: 22, kwhUncontrolled: 28 });
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
      backfillVersion: 2,
      meterKwhBackfillDone: true,
      meterKwhDeviceId: 'meter-1',
      controlledBackfillVersion: 1,
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

  it('round-trips the suppression covariate and the uncontrolled split', () => {
    const record = {
      ...liveRecord('2026-01-09'),
      kwhUncontrolled: 31.5,
      suppression: { targetDeficitMs: 7_200_000, blockedByHeadroomMs: 1_800_000, deadlineMissedToBudget: true },
    };
    const normalized = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({ records: [record] })));
    expect(normalized?.records[0]).toMatchObject({
      kwhUncontrolled: 31.5,
      suppression: { targetDeficitMs: 7_200_000, blockedByHeadroomMs: 1_800_000, deadlineMissedToBudget: true },
    });
  });

  it('round-trips a well-shaped lastAutoApply, and strips a malformed one (keeping records)', () => {
    const base = { records: [liveRecord('2026-01-09')] };
    const good = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({
      ...base, lastAutoApply: { dateKey: '2026-01-09', kwh: 44, appliedAtMs: 1_700_000_000_000 },
    })));
    expect(good?.lastAutoApply).toEqual({ dateKey: '2026-01-09', kwh: 44, appliedAtMs: 1_700_000_000_000 });
    // Malformed (missing appliedAtMs) → field stripped, record survives.
    const bad = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({
      ...base, lastAutoApply: { dateKey: '2026-01-09', kwh: 44 },
    })));
    expect(bad?.lastAutoApply).toBeUndefined();
    expect(bad?.records).toHaveLength(1);
  });

  it('drops zero deficit/headroom fields so a no-censoring day persists no suppression', () => {
    const record = {
      ...liveRecord('2026-01-09'),
      suppression: { targetDeficitMs: 0, blockedByHeadroomMs: 0 },
    };
    const normalized = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({ records: [record] })));
    expect(normalized?.records[0].suppression).toBeUndefined();
    // A real deficit still survives even when paired with a zero field.
    const mixed = { ...liveRecord('2026-01-10'), suppression: { targetDeficitMs: 3_600_000, blockedByHeadroomMs: 0 } };
    const normalizedMixed = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({ records: [mixed] })));
    expect(normalizedMixed?.records[0].suppression).toEqual({ targetDeficitMs: 3_600_000 });
  });

  it('strips a malformed suppression/kwhUncontrolled but KEEPS the record (and its temperature)', () => {
    const record = {
      ...liveRecord('2026-01-09'),
      kwhUncontrolled: 'junk',
      suppression: { targetDeficitMs: 'nope', deadlineMissedToBudget: 'yes' },
    };
    const normalized = normalizeWeatherHistoryState(JSON.parse(JSON.stringify({ records: [record] })));
    expect(normalized?.records).toHaveLength(1);
    expect(normalized?.records[0].tempMeanC).toBe(liveRecord('2026-01-09').tempMeanC);
    expect(normalized?.records[0].suppression).toBeUndefined();
    expect(normalized?.records[0].kwhUncontrolled).toBeUndefined();
  });
});
