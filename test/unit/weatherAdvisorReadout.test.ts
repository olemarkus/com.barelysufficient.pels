import type {
  EnergySignatureFit,
  MetDaySummary,
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

const metDay = (dateKey: string, overrides: Partial<MetDaySummary> = {}): MetDaySummary => ({
  dateKey,
  meanTempC: 0,
  minTempC: -4,
  maxTempC: 4,
  hourCount: 24,
  fullDayCoverage: true,
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

  it('echoes the auto-apply state (and last-applied) in both ready and needs_device payloads', () => {
    const ready = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit(), lastAutoApply: { dateKey: '2026-06-12', kwh: 44, appliedAtMs: NOW_MS } },
      { settings: { enabled: true, outdoorDeviceId: 'dev-outdoor', autoApplyDailyBudget: true }, dailyBudgetEnabled: true },
    ));
    // appliedAtMs is producer-internal — the payload echo carries only date + kWh.
    expect(ready).toMatchObject({
      state: 'ready', autoApplyDailyBudget: true, dailyBudgetEnabled: true,
      lastAutoApply: { dateKey: '2026-06-12', kwh: 44 },
    });

    const needsDevice = buildWeatherAdvisorReadout(baseInput({
      settings: { enabled: true, autoApplyDailyBudget: true }, dailyBudgetEnabled: false,
    }));
    expect(needsDevice).toMatchObject({
      state: 'needs_device', autoApplyDailyBudget: true, dailyBudgetEnabled: false, lastAutoApply: null,
    });
  });

  it('defaults the auto-apply echo to false/null when unset', () => {
    const payload = buildWeatherAdvisorReadout(withState({ records: recentDays(30), latestFit: fit() }));
    expect(payload).toMatchObject({
      autoApplyDailyBudget: false, dailyBudgetEnabled: false, lastAutoApply: null,
    });
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

  it('recomputes for tomorrow from the MET cache when the stored suggestion targets the running day', () => {
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      metForecast: {
        byDay: { [TOMORROW]: metDay(TOMORROW, { meanTempC: 4, minTempC: 0, maxTempC: 8 }) },
        fetchedAtMs: NOW_MS,
      },
      latestSuggestion: {
        targetDateKey: TODAY,
        forecastMeanTempC: 12,
        forecastSource: 'met_api',
        predictedKwh: 99,
        predictedLowKwh: 90,
        predictedHighKwh: 110,
        suggestedBudgetKwh: 120,
        beyondObservedCold: false,
        beyondObservedWarm: false,
        budgetMayBeLimiting: false,
        computedAtMs: NOW_MS,
      },
    }));
    // 23 + 1.8 × (13 − 4) = 39.2 — recomputed from the fit + MET cache, not the stale 99.
    expect(payload?.forecastStatus).toBe('forecast');
    expect(payload?.prediction?.tempMeanC).toBe(4);
    expect(payload?.prediction?.tempMinC).toBe(0);
    expect(payload?.prediction?.tempMaxC).toBe(8);
    expect(payload?.prediction?.kwh).toBeCloseTo(39.2, 5);
  });

  it('reads the TOMORROW day from a cache that also holds today (card is forward-looking)', () => {
    // The per-day cache carries both today and tomorrow; the readout card must
    // resolve TOMORROW (warm), not today (cold) — the opposite of the auto-apply path.
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      metForecast: {
        byDay: {
          [TODAY]: metDay(TODAY, { meanTempC: -10, minTempC: -14, maxTempC: -6 }),
          [TOMORROW]: metDay(TOMORROW, { meanTempC: 5, minTempC: 1, maxTempC: 9 }),
        },
        fetchedAtMs: NOW_MS,
      },
    }));
    expect(payload?.forecastStatus).toBe('forecast');
    expect(payload?.prediction?.tempMeanC).toBe(5); // tomorrow, not today's -10
    expect(payload?.prediction?.tempMinC).toBe(1);
  });

  it('filters a persisted null out of a reused stored suggestion (tempMin/Max round-trip)', () => {
    // A suggestion that round-tripped through JSON can carry null where the field
    // is optional; `!= null` must keep it out of the number-typed prediction field.
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      latestSuggestion: {
        targetDateKey: TOMORROW,
        forecastMeanTempC: -2,
        forecastSource: 'met_api',
        predictedKwh: 50,
        predictedLowKwh: 44,
        predictedHighKwh: 58,
        suggestedBudgetKwh: 55,
        beyondObservedCold: false,
        beyondObservedWarm: false,
        budgetMayBeLimiting: false,
        tempMinC: null as unknown as number,
        tempMaxC: null as unknown as number,
        coldEveningSuspected: null as unknown as boolean,
        computedAtMs: NOW_MS,
      },
    }));
    expect(payload?.prediction?.kwh).toBe(50);
    expect(payload?.prediction?.tempMinC).toBeUndefined();
    expect(payload?.prediction?.tempMaxC).toBeUndefined();
    expect(payload?.suggestion?.coldEveningSuspected).toBeUndefined();
  });

  it('falls back to persistence with recent_no_device when there is no MET cache for tomorrow', () => {
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
    }));
    expect(payload?.forecastStatus).toBe('recent_no_device');
    expect(payload?.suggestion).not.toBeNull();
  });

  it('reports forecast (met_api) when the MET cache covers tomorrow', () => {
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(),
      metForecast: {
        byDay: { [TOMORROW]: metDay(TOMORROW, { meanTempC: -2, minTempC: -6, maxTempC: 2, eveningMinTempC: -5 }) },
        fetchedAtMs: NOW_MS,
      },
    }));
    expect(payload?.forecastStatus).toBe('forecast');
    expect(payload?.prediction?.tempMinC).toBe(-6);
    // 1 °C mean (mild day) below balance? mean -2 < balance 13 → flat cold, not an evening swing.
    expect(payload?.suggestion?.coldEveningSuspected).toBe(false);
  });

  it('surfaces coldEveningSuspected from a mild-day MET cache with a cold evening', () => {
    const payload = buildWeatherAdvisorReadout(withState({
      records: recentDays(30),
      latestFit: fit(), // balancePointC 13
      metForecast: {
        byDay: { [TOMORROW]: metDay(TOMORROW, { meanTempC: 14, minTempC: 8, maxTempC: 19, eveningMinTempC: 10 }) },
        fetchedAtMs: NOW_MS,
      },
    }));
    expect(payload?.suggestion?.coldEveningSuspected).toBe(true);
  });

  it('reuses a lingering forecast_device suggestion as forecast (BC) when it targets tomorrow', () => {
    // A suggestion persisted by the retired +24h-device path still maps to the
    // forecast footer state for BC (PR 2 drops the legacy source).
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
    expect(payload?.prediction?.kwh).toBe(50);
    expect(payload?.forecastStatus).toBe('forecast');
  });

  it('resolves the outdoor reading from the on-demand read; forecast is always no_device now', () => {
    const reading = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit() },
      { settings: SETTINGS_WITH_FORECAST, currentOutdoorTempC: 3.4 },
    ));
    expect(reading?.outdoorReading).toEqual({ status: 'reading', tempC: 3.4 });
    // No forecast device source anymore — forecastReading is always no_device.
    expect(reading?.forecastReading).toEqual({ status: 'no_device' });

    // Outdoor configured but nothing readable → unreadable.
    const unreadable = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit() },
      { settings: SETTINGS_WITH_FORECAST },
    ));
    expect(unreadable?.outdoorReading).toEqual({ status: 'unreadable' });
    expect(unreadable?.forecastReading).toEqual({ status: 'no_device' });
  });

  it('resolves forecastStatus even in the needs_device state (no outdoor device)', () => {
    const payload = buildWeatherAdvisorReadout(baseInput({
      settings: { enabled: true },
    }));
    expect(payload?.state).toBe('needs_device');
    // No MET cache for tomorrow → recent_no_device.
    expect(payload?.forecastStatus).toBe('recent_no_device');
  });

  it('surfaces the active daily budget (null when disabled) for the setup-card hint', () => {
    expect(buildWeatherAdvisorReadout(baseInput({ settings: { enabled: true } }))?.dailyBudgetKwh)
      .toBeNull();
    expect(buildWeatherAdvisorReadout(baseInput({ currentDailyBudgetKwh: 50 }))?.dailyBudgetKwh)
      .toBe(50);
  });

  it('marks the suggestion as capacity-capped when expected demand exceeds cap × 24h', () => {
    const payload = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit() },
      { capacityLimitKw: 1, currentDailyBudgetKwh: 20 },
    ));
    // Prediction (~29 kWh) > cap × 24 (24 kWh) → genuinely over-cap.
    expect(payload?.suggestion?.cappedByCapacity).toBe(true);
    expect(payload?.suggestion?.kwh).toBeLessThanOrEqual(24);
    expect(payload?.suggestion?.currentDailyBudgetKwh).toBe(20);
  });

  it('does NOT flag capacity-capped when expected demand fits under a tiny cap (floor clamps, not demand)', () => {
    // A 0.5 kW cap (12 kWh/day) clamps the [20,360] suggestion floor below the cap,
    // but tomorrow's predicted demand (8 kWh, uncorrelated) fits — so not over-cap.
    const payload = buildWeatherAdvisorReadout(withState(
      { records: recentDays(30), latestFit: fit({ model: 'uncorrelated', medianDayKwh: 8 }) },
      { capacityLimitKw: 0.5 },
    ));
    expect(payload?.prediction?.kwh).toBeLessThan(12);
    expect(payload?.suggestion?.cappedByCapacity).toBe(false);
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
