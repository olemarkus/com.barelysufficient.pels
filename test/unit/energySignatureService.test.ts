import type { Logger as PinoLogger } from 'pino';
import type {
  EnergySignatureFit,
  MetDaySummary,
  WeatherHistoryState,
  WeatherDailyRecord,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  computeEnergySignatureUpdate,
  resolveComingDayFromState,
  resolveMetDay,
} from '../../lib/weather/energySignatureService';

// 2026-06-01T00:00Z; Oslo is UTC+2 → todayKey 2026-06-01, tomorrow 2026-06-02.
const NOW_MS = Date.UTC(2026, 5, 1, 10, 0, 0);
const OSLO = 'Europe/Oslo';

const day = (index: number, tempC: number, kwh: number): WeatherDailyRecord => ({
  dateKey: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
  kwhTotal: kwh,
  tempMeanC: tempC,
  tempMinC: tempC - 2,
  tempMaxC: tempC + 2,
  tempSampleCount: 24,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
});

const heatingHistory = (): WeatherDailyRecord[] => Array.from({ length: 80 }, (_, index) => {
  const tempC = -8 + (28 * index) / 79;
  return day(index, tempC, 20 + 2 * Math.max(0, 15 - tempC) + (index % 2 === 0 ? 1 : -1));
});

const buildDeps = () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    deps: {
      getNowMs: () => NOW_MS,
      getTimeZone: () => OSLO,
      getCapacityLimitKw: () => 10,
      logger: logger as unknown as PinoLogger,
    },
  };
};

describe('computeEnergySignatureUpdate', () => {
  // The auto-apply rollup targets the JUST-STARTED day (today = 2026-06-01); the
  // MET cache must carry that day for met_api to win.
  const TODAY = '2026-06-01';
  const TOMORROW = '2026-06-02';
  const metDay = (overrides: Partial<MetDaySummary> = {}): MetDaySummary => ({
    dateKey: TODAY,
    meanTempC: -2,
    minTempC: -6,
    maxTempC: 2,
    eveningMinTempC: -5,
    eveningMeanTempC: -4,
    hourCount: 24,
    fullDayCoverage: true,
    ...overrides,
  });
  const metCache = (
    day: Partial<MetDaySummary> = {},
  ): NonNullable<WeatherHistoryState['metForecast']> => {
    const today = metDay(day);
    return { byDay: { [today.dateKey]: today }, fetchedAtMs: NOW_MS };
  };

  it('stamps fit and the persistence-fallback suggestion (targets the just-started day) and logs one event', () => {
    const { deps, logger } = buildDeps();
    const state: WeatherHistoryState = { records: heatingHistory() };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestFit?.model).toBe('changepoint');
    // No MET cache → persistence fallback, targeting the just-started day.
    expect(next.latestSuggestion?.forecastSource).toBe('recent_days');
    expect(next.latestSuggestion?.targetDateKey).toBe(TODAY);
    expect(next.latestSuggestion?.suggestedBudgetKwh).toBeGreaterThan(0);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_advisor_fit',
      status: 'fitted',
      model: 'changepoint',
    }));
  });

  it('reads the MET cache for the just-started day (NOT tomorrow) as the coming-day mean', () => {
    const { deps } = buildDeps();
    const state: WeatherHistoryState = { records: heatingHistory(), metForecast: metCache() };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestSuggestion?.forecastSource).toBe('met_api');
    // The auto-apply suggestion targets the just-started day, so the active daily
    // budget is set from THAT day's forecast — not D+1's.
    expect(next.latestSuggestion?.targetDateKey).toBe(TODAY);
    expect(next.latestSuggestion?.forecastMeanTempC).toBe(-2);
    expect(next.latestSuggestion?.tempMinC).toBe(-6);
    expect(next.latestSuggestion?.tempMaxC).toBe(2);
    // Colder forecast ⇒ a markedly higher prediction than the warm recent days.
    expect(next.latestSuggestion?.predictedKwh).toBeGreaterThan(40);
  });

  it('does NOT read a cache that only covers tomorrow for the auto-apply (just-started) day', () => {
    const { deps } = buildDeps();
    // Cache holds tomorrow only — the readout card would use it, but auto-apply
    // needs the just-started day, so it falls back to persistence.
    const tomorrowOnly = metDay({ dateKey: TOMORROW });
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      metForecast: { byDay: { [TOMORROW]: tomorrowOnly }, fetchedAtMs: NOW_MS },
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestSuggestion?.forecastSource).toBe('recent_days');
    expect(next.latestSuggestion?.targetDateKey).toBe(TODAY);
  });

  it('falls back to persistence when the MET cache covers no relevant day', () => {
    const { deps } = buildDeps();
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      metForecast: metCache({ dateKey: '2026-05-30' }), // stale: neither today nor tomorrow
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestSuggestion?.forecastSource).toBe('recent_days');
    expect(next.latestSuggestion?.targetDateKey).toBe(TODAY);
  });

  it('falls back to persistence when the just-started day is only PARTIALLY covered (mid-day restart)', () => {
    const { deps } = buildDeps();
    // A boot/catch-up after the day is underway yields a partial today (MET only
    // forecasts from "now" forward) — budgeting off that half-day mean is biased,
    // so auto-apply must fall back to persistence rather than use it.
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      metForecast: metCache({ fullDayCoverage: false, hourCount: 9 }),
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestSuggestion?.forecastSource).toBe('recent_days');
    expect(next.latestSuggestion?.targetDateKey).toBe(TODAY);
  });

  it('derives coldEveningSuspected when the evening dips below balance but the day mean does not', () => {
    const { deps } = buildDeps();
    // changepoint fit's balance point is ~15 °C here; a mild day (mean above
    // balance) with a cold evening below it is a genuine evening swing.
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      metForecast: metCache({ meanTempC: 16, minTempC: 5, maxTempC: 20, eveningMinTempC: 8 }),
    };
    const next = computeEnergySignatureUpdate(state, deps);
    const balance = next.latestFit?.balancePointC ?? 0;
    expect(balance).toBeGreaterThan(8);
    expect(next.latestSuggestion?.coldEveningSuspected).toBe(true);
  });

  it('does not flag coldEveningSuspected on a flat-cold day (mean already below balance)', () => {
    const { deps } = buildDeps();
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      metForecast: metCache({ meanTempC: -2, eveningMinTempC: -5 }),
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestSuggestion?.coldEveningSuspected).toBe(false);
  });

  it('does not derive a bogus coldEveningSuspected when balancePointC is null (persisted round-trip)', () => {
    // A mild day (mean 16) with a cold evening (8) would trip the verdict — but
    // the fit's balancePointC deserialized as null. A strict `=== undefined` would
    // let null through and `8 < null` coerces to `8 < 0` → false, while `16 >= 0`
    // → true, fabricating a verdict against a 0 °C balance. The `!= null` guard
    // must instead return undefined.
    const fitWithNullBalance = {
      balancePointC: null, model: 'linear', slopeKwhPerDegree: 1,
    } as unknown as EnergySignatureFit;
    const state: WeatherHistoryState = {
      records: [],
      metForecast: metCache({ dateKey: TODAY, meanTempC: 16, minTempC: 5, maxTempC: 20, eveningMinTempC: 8 }),
    };
    const resolved = resolveComingDayFromState(state, fitWithNullBalance, TODAY);
    expect(resolved?.source).toBe('met_api');
    expect(resolved?.coldEveningSuspected).toBeUndefined();
  });

  it('resolveMetDay returns the entry only on an exact dateKey match', () => {
    const cache = metCache({ dateKey: TODAY });
    expect(resolveMetDay(cache, TODAY)?.dateKey).toBe(TODAY);
    expect(resolveMetDay(cache, TOMORROW)).toBeUndefined();
    expect(resolveMetDay(undefined, TODAY)).toBeUndefined();
  });

  it('strips a stale suggestion when the forecast is unresolvable beside a fresh fit', () => {
    const { deps } = buildDeps();
    const records = heatingHistory().map((record, index, all) => (
      index >= all.length - 7
        ? { ...record, quality: { ...record.quality, partialTemp: true } }
        : record
    ));
    const state: WeatherHistoryState = {
      records,
      latestSuggestion: { computedAtMs: 1 } as WeatherHistoryState['latestSuggestion'],
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestFit).toBeDefined();
    expect(next.latestSuggestion).toBeUndefined();
  });

  it('strips stale derived fields and logs learning while under the data gate', () => {
    const { deps, logger } = buildDeps();
    const state: WeatherHistoryState = {
      records: heatingHistory().slice(0, 10),
      latestFit: { model: 'changepoint' } as WeatherHistoryState['latestFit'],
      latestSuggestion: {} as WeatherHistoryState['latestSuggestion'],
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestFit).toBeUndefined();
    expect(next.latestSuggestion).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_advisor_fit',
      status: 'learning',
    }));
  });
});
