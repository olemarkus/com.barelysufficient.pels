import type {
  EnergySignatureFit,
  WeatherDailyRecord,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  buildWeatherAdvisorReadout,
  type WeatherAdvisorReadoutInput,
} from '../../lib/weather/weatherAdvisorReadout';
import { shiftDateKey } from '../../lib/utils/dateUtils';

// 2026-06-11 12:00 UTC; the test timezone is UTC so dateKeys stay literal.
const NOW_MS = Date.UTC(2026, 5, 11, 12, 0, 0);
const TODAY = '2026-06-11';
const YESTERDAY = '2026-06-10';
const TOMORROW = '2026-06-12';

const record = (dateKey: string, overrides: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  dateKey,
  kwhTotal: 40,
  tempMeanC: 5,
  tempMinC: 2,
  tempMaxC: 8,
  tempSampleCount: 24,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
  ...overrides,
});

const fit = (overrides: Partial<EnergySignatureFit> = {}): EnergySignatureFit => ({
  model: 'changepoint',
  baseLoadKwhPerDay: 23,
  slopeKwhPerDegree: 1.8,
  balancePointC: 13,
  pseudoR2: 0.7,
  usableDays: 120,
  observedTempMinC: -10,
  observedTempMaxC: 22,
  medianDayKwh: 38,
  lowObservedDayKwh: 20,
  confidence: 'medium',
  curvatureSteeperWhenCold: false,
  driftSuspected: false,
  suppressedDaysExcluded: 0,
  suppressionFilterRelaxed: false,
  recentColdSuppressionSuspected: false,
  residualQ10: -4,
  residualQ50: 0,
  residualQ80: 4,
  residualQ90: 6,
  fittedAtMs: NOW_MS,
  ...overrides,
});

const recentDays = (count: number): WeatherDailyRecord[] => (
  Array.from({ length: count }, (_, index) => (
    record(shiftDateKey(TODAY, index - count), { tempMeanC: 5 + (index % 10) })
  ))
);

const baseInput = (overrides: Partial<WeatherAdvisorReadoutInput> = {}): WeatherAdvisorReadoutInput => ({
  settings: { enabled: true, outdoorDeviceId: 'dev-outdoor' },
  state: { records: recentDays(30) },
  backfillRunning: false,
  nowMs: NOW_MS,
  timeZone: 'UTC',
  ...overrides,
});

const withState = (state: Partial<WeatherHistoryState>, overrides: Partial<WeatherAdvisorReadoutInput> = {}) => (
  baseInput({ state: { records: [], ...state }, ...overrides })
);

const SETTINGS_WITH_FORECAST = {
  enabled: true, outdoorDeviceId: 'dev-outdoor', forecastDeviceId: 'dev-forecast',
};

describe('buildWeatherAdvisorReadout', () => {
  it('returns null when the flag is off (structural absence)', () => {
    expect(buildWeatherAdvisorReadout(baseInput({ settings: { enabled: false } }))).toBeNull();
  });

  it('resolves needs_device with empty data when no outdoor device is picked', () => {
    const payload = buildWeatherAdvisorReadout(baseInput({ settings: { enabled: true } }));
    expect(payload).toMatchObject({
      state: 'needs_device', fit: null, prediction: null, suggestion: null, usableDays: 0,
    });
    expect(payload?.scatter).toEqual([]);
    expect(payload?.coverage).toEqual([]);
  });

  it('resolves backfilling only while no fit exists yet', () => {
    const learning = buildWeatherAdvisorReadout(baseInput({ backfillRunning: true }));
    expect(learning?.state).toBe('backfilling');
    const ready = buildWeatherAdvisorReadout(
      withState({ records: recentDays(30), latestFit: fit() }, { backfillRunning: true }),
    );
    expect(ready?.state).toBe('ready');
  });

  it('counts usable days for the learning state and skips quality-flagged days', () => {
    const records = [
      ...recentDays(8),
      record(shiftDateKey(TODAY, -40), { quality: { partialTemp: true, missingKwh: false, unreliablePower: false, backfilled: false } }),
      record(shiftDateKey(TODAY, -41), { kwhTotal: undefined as unknown as number, quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: false } }),
    ];
    const payload = buildWeatherAdvisorReadout(withState({ records }));
    expect(payload?.state).toBe('learning');
    expect(payload?.usableDays).toBe(8);
  });

  it('reuses the stored suggestion when it already targets tomorrow', () => {
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      latestSuggestion: {
        targetDateKey: TOMORROW,
        forecastMeanTempC: -2,
        forecastSource: 'forecast_device',
        predictedKwh: 50,
        predictedLowKwh: 44,
        predictedHighKwh: 58,
        suggestedBudgetKwh: 55,
        beyondObservedCold: false,
        beyondObservedWarm: false,
        budgetMayBeLimiting: false,
        computedAtMs: NOW_MS,
      },
    }, { settings: SETTINGS_WITH_FORECAST }));
    expect(payload?.prediction).toMatchObject({ tempMeanC: -2, kwh: 50, lowKwh: 44, highKwh: 58 });
    expect(payload?.forecastStatus).toBe('forecast');
    expect(payload?.suggestion?.kwh).toBe(55);
  });

  it('recomputes for tomorrow when the stored suggestion targets the running day', () => {
    const forecastHours = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour).padStart(2, '0'), 4]),
    );
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      latestSuggestion: {
        targetDateKey: TODAY,
        forecastMeanTempC: 12,
        forecastSource: 'forecast_device',
        predictedKwh: 99,
        predictedLowKwh: 90,
        predictedHighKwh: 110,
        suggestedBudgetKwh: 120,
        beyondObservedCold: false,
        beyondObservedWarm: false,
        budgetMayBeLimiting: false,
        computedAtMs: NOW_MS,
      },
      forecastHourly: { [TOMORROW]: forecastHours },
    }, { settings: SETTINGS_WITH_FORECAST }));
    // 23 + 1.8 × (13 − 4) = 39.2 — recomputed from the fit, not the stale 99.
    expect(payload?.forecastStatus).toBe('forecast');
    expect(payload?.prediction?.tempMeanC).toBe(4);
    expect(payload?.prediction?.kwh).toBeCloseTo(39.2, 5);
  });

  it('falls back to persistence with recent_no_device when no forecast device is configured', () => {
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
    }));
    expect(payload?.forecastStatus).toBe('recent_no_device');
    expect(payload?.suggestion).not.toBeNull();
  });

  it('reports recent_device_unreadable when a forecast device is set but not reporting', () => {
    const payload = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit() },
      { settings: SETTINGS_WITH_FORECAST },
    ));
    expect(payload?.forecastStatus).toBe('recent_device_unreadable');
  });

  it('reports recent_no_device when a forecast-derived suggestion lingers after the device was removed', () => {
    // Stored suggestion is forecast-derived, but the forecast device is no longer
    // configured — status must reflect the current (deviceless) wiring so the
    // footer says "none" instead of claiming the removed device.
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      latestSuggestion: {
        targetDateKey: TOMORROW, forecastMeanTempC: -2, forecastSource: 'forecast_device',
        predictedKwh: 50, predictedLowKwh: 44, predictedHighKwh: 58, suggestedBudgetKwh: 55,
        beyondObservedCold: false, beyondObservedWarm: false, budgetMayBeLimiting: false,
        computedAtMs: NOW_MS,
      },
    }));
    expect(payload?.prediction?.kwh).toBe(50); // still reuses the stored forecast number…
    expect(payload?.forecastStatus).toBe('recent_no_device'); // …but wiring is deviceless now
  });

  it('resolves forecastStatus even in the needs_device state (no outdoor device)', () => {
    const payload = buildWeatherAdvisorReadout(baseInput({
      settings: { enabled: true, forecastDeviceId: 'dev-forecast' },
    }));
    expect(payload?.state).toBe('needs_device');
    expect(payload?.forecastStatus).toBe('recent_device_unreadable');
  });

  it('marks the suggestion as capacity-capped when cap × 24h clamps it', () => {
    const payload = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit() },
      { capacityLimitKw: 1, currentDailyBudgetKwh: 20 },
    ));
    expect(payload?.suggestion?.cappedByCapacity).toBe(true);
    expect(payload?.suggestion?.kwh).toBeLessThanOrEqual(24);
    expect(payload?.suggestion?.currentDailyBudgetKwh).toBe(20);
  });

  it('decimates usable days into 1 °C bins and ships raw recent days with quality', () => {
    const records = [
      record(shiftDateKey(TODAY, -3), { tempMeanC: 1.2, kwhTotal: 40 }),
      record(shiftDateKey(TODAY, -2), { tempMeanC: 0.8, kwhTotal: 44 }),
      record(YESTERDAY, {
        tempMeanC: 0.9,
        kwhTotal: 48,
        quality: { partialTemp: true, missingKwh: false, unreliablePower: false, backfilled: false },
      }),
    ];
    const payload = buildWeatherAdvisorReadout(withState({ records }));
    // Partial-temp day is excluded from the bins but still plotted raw.
    expect(payload?.scatter).toEqual([
      { tempBinC: 1, kwhMedian: 42, kwhQ1: 41, kwhQ3: 43, count: 2 },
    ]);
    expect(payload?.recentDays).toHaveLength(3);
    expect(payload?.recentDays[2]).toMatchObject({ dateKey: YESTERDAY, quality: { partialTemp: true } });
  });

  it('builds 5 °C coverage bins with the ≥14-day sufficiency gate', () => {
    const cold = Array.from({ length: 14 }, (_, index) => (
      record(shiftDateKey(TODAY, -(index + 2)), { tempMeanC: -7 })
    ));
    const warm = [record(shiftDateKey(TODAY, -20), { tempMeanC: 6 })];
    const payload = buildWeatherAdvisorReadout(withState({ records: [...warm, ...cold] }));
    expect(payload?.coverage).toEqual([
      { fromC: -10, toC: -5, days: 14, sufficient: true },
      { fromC: -5, toC: 0, days: 0, sufficient: false },
      { fromC: 0, toC: 5, days: 0, sufficient: false },
      { fromC: 5, toC: 10, days: 1, sufficient: false },
    ]);
  });

  it('resolves yesterday with its deviation from typical', () => {
    const older = Array.from({ length: 25 }, (_, index) => (
      record(shiftDateKey(TODAY, -(index + 2)), { tempMeanC: 5 + (index % 10) })
    ));
    const records = [
      ...older,
      record(YESTERDAY, { tempMeanC: 3, kwhTotal: 47 }),
    ].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const payload = buildWeatherAdvisorReadout(withState({ records, latestFit: fit() }));
    // Typical at 3 °C = 23 + 1.8 × 10 = 41 → deviation +6.
    expect(payload?.yesterday).toMatchObject({ dateKey: YESTERDAY, kwhTotal: 47 });
    expect(payload?.yesterday?.deviationKwh).toBeCloseTo(6, 5);
  });

  it('surfaces the drift magnitude only while drift is suspected', () => {
    const calm = buildWeatherAdvisorReadout(withState({ records: recentDays(30), latestFit: fit() }));
    expect(calm?.driftSuspected).toBe(false);
    expect(calm?.driftDeviationKwh).toBeNull();

    const driftRecords = recentDays(30).map((entry) => ({ ...entry, tempMeanC: 13, kwhTotal: 28 }));
    const drifted = buildWeatherAdvisorReadout(withState({
      records: driftRecords,
      latestFit: fit({ driftSuspected: true }),
    }));
    expect(drifted?.driftSuspected).toBe(true);
    // All days at the balance point: typical = base load 23, actual 28 → +5.
    expect(drifted?.driftDeviationKwh).toBeCloseTo(5, 5);
  });
});
