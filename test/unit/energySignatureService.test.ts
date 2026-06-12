import type { Logger as PinoLogger } from 'pino';
import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';

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
  it('stamps fit and suggestion onto the state and logs one structured event', () => {
    const { deps, logger } = buildDeps();
    const state: WeatherHistoryState = { records: heatingHistory() };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestFit?.model).toBe('changepoint');
    expect(next.latestSuggestion?.forecastSource).toBe('recent_days');
    expect(next.latestSuggestion?.targetDateKey).toBe('2026-06-01');
    expect(next.latestSuggestion?.suggestedBudgetKwh).toBeGreaterThan(0);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_advisor_fit',
      status: 'fitted',
      model: 'changepoint',
    }));
  });

  it('prefers a sufficiently filled forecast-device profile for tomorrow', () => {
    const { deps } = buildDeps();
    const forecastHours = Object.fromEntries(
      Array.from({ length: 14 }, (_, hour) => [String(hour).padStart(2, '0'), -2]),
    );
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      forecastHourly: { '2026-06-02': forecastHours },
    };
    const next = computeEnergySignatureUpdate(state, deps);
    expect(next.latestSuggestion?.forecastSource).toBe('forecast_device');
    expect(next.latestSuggestion?.targetDateKey).toBe('2026-06-02');
    expect(next.latestSuggestion?.forecastMeanTempC).toBe(-2);
    // Colder forecast ⇒ a markedly higher prediction than the warm recent days.
    expect(next.latestSuggestion?.predictedKwh).toBeGreaterThan(40);
  });

  it('prefers the just-started day at the midnight recompute (its profile is complete)', () => {
    const { deps } = buildDeps();
    const fullDay = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour).padStart(2, '0'), 1]),
    );
    const state: WeatherHistoryState = {
      records: heatingHistory(),
      // At Oslo 00:05 on 06-02, "today" is 06-02 — filled across yesterday —
      // while 06-03 holds a single hour so far.
      forecastHourly: { '2026-06-02': fullDay, '2026-06-03': { '00': 5 } },
    };
    const next = computeEnergySignatureUpdate(state, {
      ...deps,
      getNowMs: () => Date.UTC(2026, 5, 1, 22, 5, 0), // Oslo 2026-06-02 00:05
    });
    expect(next.latestSuggestion?.forecastSource).toBe('forecast_device');
    expect(next.latestSuggestion?.targetDateKey).toBe('2026-06-02');
    expect(next.latestSuggestion?.forecastMeanTempC).toBe(1);
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
