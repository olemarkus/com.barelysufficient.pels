import type { Logger as PinoLogger } from 'pino';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';
import { fetchMetForecast } from '../../lib/weather/metForecast';
import type {
  WeatherDailyRecord,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey } from '../../lib/utils/dateUtils';

/**
 * Integration (collector layer): tomorrow's budget forecast sourced from MET
 * Norway. The real `fetchMetForecast` parser, the real collector cache/refresh,
 * and the real energy-signature recompute all run; only the collector's own
 * injected outward seams (persistence store, Homey Web API / kWh totals, and the
 * MET HTTP `fetch`) are mocked via the deps — which the integration tier permits.
 * It confirms the whole chain reduces a MET compact response to a `met_api`
 * daily-budget suggestion, not our assumptions about it.
 *
 * Tiering note: this lives in the integration lane (not e2e) because it injects
 * `recomputeDerived`/`store`/`fetchInsights` rather than driving the full app
 * through only the Homey SDK boundary. Observe through persisted state + the
 * structured `weather_advisor_fit` log, never PELS internals.
 */

const OSLO = 'Europe/Oslo';
// 2026-01-10 11:00 Oslo (UTC+1) → todayKey 2026-01-10, tomorrow 2026-01-11.
const START_MS = Date.UTC(2026, 0, 10, 10, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const TOMORROW_DAY_START_UTC_MS = Date.UTC(2026, 0, 10, 23, 0, 0); // Oslo 2026-01-11 00:00

/** A changepoint-shaped year of usable days so the fit is real (not learning). */
const heatingHistory = (): WeatherDailyRecord[] => Array.from({ length: 80 }, (_, index) => {
  const tempC = -8 + (28 * index) / 79;
  const dateKey = new Date(Date.UTC(2025, 9, 1) + index * 24 * HOUR_MS).toISOString().slice(0, 10);
  return {
    dateKey,
    kwhTotal: 20 + 2 * Math.max(0, 15 - tempC) + (index % 2 === 0 ? 1 : -1),
    tempMeanC: tempC,
    tempMinC: tempC - 2,
    tempMaxC: tempC + 2,
    tempSampleCount: 24,
    quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
  };
});

/** 24 hourly points for one local day: mild midday, cold evening (local 17–23) — a genuine swing. */
const dayHours = (dateKey: string): unknown[] => {
  const dayStartUtcMs = getDateKeyStartMs(dateKey, OSLO);
  return Array.from({ length: 24 }, (_, localHour) => {
    const instantMs = dayStartUtcMs + localHour * HOUR_MS;
    const tempC = localHour >= 17 && localHour <= 23 ? -4 : 2;
    return {
      time: new Date(instantMs).toISOString(),
      data: {
        instant: { details: { air_temperature: tempC } },
        next_1_hours: { summary: { symbol_code: 'partlycloudy_night' }, details: { precipitation_amount: 0 } },
      },
    };
  });
};

/**
 * A MET Locationforecast 2.0 (compact) envelope covering BOTH the current local
 * day AND tomorrow (the per-day cache needs both), built relative to `nowMs` so it
 * stays correct across the midnight rollup re-fetch.
 */
const metCompactBody = (nowMs: number): unknown => {
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), OSLO);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  return {
    properties: { timeseries: [...dayHours(todayKey), ...dayHours(tomorrowKey)] },
  };
};

/** Minimal fetch-Response stand-in for the MET HTTP boundary. */
type FakeResponse = typeof fetch extends (...args: never[]) => Promise<infer R> ? R : never;

const metResponse = (body: unknown): FakeResponse => {
  const headers: Record<string, string> = {
    expires: new Date(START_MS + 30 * 60 * 1000).toUTCString(),
    'last-modified': 'Sat, 10 Jan 2026 09:00:00 GMT',
  };
  return {
    status: 200,
    ok: true,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as FakeResponse;
};

describe('weather MET forecast integration (MET HTTP boundary mocked)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches today+tomorrow from MET and the rollup suggestion targets the just-started day', async () => {
    const persisted: { value: WeatherHistoryState } = { value: { records: heatingHistory() } };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () => metResponse(metCompactBody(Date.now())));

    const collector = new WeatherCollector({
      store: {
        read: () => persisted.value,
        write: (state) => { persisted.value = JSON.parse(JSON.stringify(state)) as WeatherHistoryState; },
      },
      readDevice: async (deviceId) => ({
        id: deviceId, name: 'Outdoor', capabilitiesObj: { measure_temperature: { value: 1 } },
      }),
      fetchInsights: async () => ({ step: 6 * HOUR_MS, values: [] }),
      getDailyKwh: () => ({}),
      getDaySuppression: () => ({}),
      isManagedDevice: () => false,
      getUnreliablePeriods: () => [],
      getSettings: () => ({ enabled: true, outdoorDeviceId: 'out-1' }),
      getNowMs: () => Date.now(),
      getTimeZone: () => OSLO,
      // The real fetcher; only its HTTP boundary (`fetchImpl`) is faked.
      fetchForecast: ({ ifModifiedSince }) => fetchMetForecast({
        latitude: 59.91,
        longitude: 10.75,
        timeZone: OSLO,
        nowMs: Date.now(),
        userAgent: 'com.barelysufficient.pels/test (https://pels.barelysufficient.org/)',
        fetchImpl,
        ...(ifModifiedSince !== undefined ? { ifModifiedSince } : {}),
      }),
      recomputeDerived: (state) => computeEnergySignatureUpdate(state, {
        getNowMs: () => Date.now(),
        getTimeZone: () => OSLO,
        getCapacityLimitKw: () => undefined,
        logger: logger as unknown as PinoLogger,
      }),
      logger: logger as unknown as PinoLogger,
    });

    collector.start();
    // Let the boot MET refresh resolve through the real parser + cache.
    await vi.advanceTimersByTimeAsync(30_000);

    // The HTTP boundary was hit and the parsed summaries cached per local day.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const bootCache = persisted.value.metForecast;
    expect(Object.keys(bootCache?.byDay ?? {}).sort()).toEqual(['2026-01-10', '2026-01-11']);
    const bootTomorrow = bootCache?.byDay['2026-01-11'];
    // Simple per-hour mean of 24 hourly values (mild day + cold evening).
    expect(bootTomorrow?.meanTempC).toBeLessThan(2);
    expect(bootTomorrow?.meanTempC).toBeGreaterThan(-4);
    expect(bootTomorrow?.eveningMinTempC).toBe(-4);

    // Drive the real midnight rollup: it re-refreshes MET for the new local day
    // window (2026-01-11 today + 2026-01-12 tomorrow) BEFORE the recompute, so the
    // auto-apply suggestion is MET-sourced and targets the JUST-STARTED day.
    await vi.advanceTimersByTimeAsync(TOMORROW_DAY_START_UTC_MS + 5 * 60 * 1000 - Date.now());
    collector.stop();

    const cache = persisted.value.metForecast;
    expect(Object.keys(cache?.byDay ?? {}).sort()).toEqual(['2026-01-11', '2026-01-12']);
    const suggestion = persisted.value.latestSuggestion;
    expect(suggestion?.forecastSource).toBe('met_api');
    // The just-started day, NOT tomorrow — its forecast drives the active budget.
    expect(suggestion?.targetDateKey).toBe('2026-01-11');
    expect(suggestion?.forecastMeanTempC).toBe(cache?.byDay['2026-01-11']?.meanTempC);
    expect(suggestion?.tempMinC).toBe(-4);
    expect(suggestion?.tempMaxC).toBe(2);
    expect(suggestion?.suggestedBudgetKwh).toBeGreaterThan(0);

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_advisor_fit',
      status: 'fitted',
      forecastSource: 'met_api',
    }));
  });

  it('falls back to persistence (recent_days) when MET cannot be reached', async () => {
    const persisted: { value: WeatherHistoryState } = { value: { records: heatingHistory() } };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });

    const collector = new WeatherCollector({
      store: {
        read: () => persisted.value,
        write: (state) => { persisted.value = JSON.parse(JSON.stringify(state)) as WeatherHistoryState; },
      },
      readDevice: async (deviceId) => ({
        id: deviceId, name: 'Outdoor', capabilitiesObj: { measure_temperature: { value: 1 } },
      }),
      fetchInsights: async () => ({ step: 6 * HOUR_MS, values: [] }),
      getDailyKwh: () => ({}),
      getDaySuppression: () => ({}),
      isManagedDevice: () => false,
      getUnreliablePeriods: () => [],
      getSettings: () => ({ enabled: true, outdoorDeviceId: 'out-1' }),
      getNowMs: () => Date.now(),
      getTimeZone: () => OSLO,
      fetchForecast: () => fetchMetForecast({
        latitude: 59.91,
        longitude: 10.75,
        timeZone: OSLO,
        nowMs: Date.now(),
        userAgent: 'com.barelysufficient.pels/test (https://pels.barelysufficient.org/)',
        fetchImpl,
      }),
      recomputeDerived: (state) => computeEnergySignatureUpdate(state, {
        getNowMs: () => Date.now(),
        getTimeZone: () => OSLO,
        getCapacityLimitKw: () => undefined,
        logger: logger as unknown as PinoLogger,
      }),
      logger: logger as unknown as PinoLogger,
    });

    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(TOMORROW_DAY_START_UTC_MS + 5 * 60 * 1000 - Date.now());
    collector.stop();

    expect(fetchImpl).toHaveBeenCalled();
    expect(persisted.value.metForecast).toBeUndefined(); // nothing cached, nothing cleared
    const suggestion = persisted.value.latestSuggestion;
    expect(suggestion?.forecastSource).toBe('recent_days');
    expect(suggestion?.targetDateKey).toBe('2026-01-11'); // the just-started day at the 00:05 rollup
  });
});
