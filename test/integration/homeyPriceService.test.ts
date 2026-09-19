import PriceService from '../../lib/price/priceService';
import type { PriceServiceLoggingSinks } from '../../lib/price/priceServiceLoggingSinks';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { mockHomeyInstance } from '../mocks/homey';
import {
  COMBINED_PRICES,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  EXPORT_FIXED,
  EXPORT_PRICE_ENABLED,
  EXPORT_PRICE_SOURCE,
  EXPORT_SPOT_FACTOR,
  HOMEY_PRICE_FORMULA,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';
import { getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey } from '../../lib/utils/dateUtils';
import { PRICE_USER_COSTS_API_PATH, type HomeyWebApiGet } from '../../lib/price/homeyPriceFormula';
import { HOMEY_EXPORT_PRICE_TERMS } from '../../lib/utils/settingsKeys';
import {
  EXPORT_FIXED_OPTION_API_PATH,
  EXPORT_TYPE_API_PATH,
  EXPORT_USER_COSTS_API_PATH,
} from '../../lib/price/homeyExportPrice';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';
import { mirrorNoHomeyPriceFormula, noHomeyWebApi } from '../helpers/homeyWebApiStub';
import type { HomeyEnergyApi, HomeyEnergyPriceInterval } from '../../lib/utils/homeyEnergy';
import { PriceLevel } from '../../lib/price/priceLevels';
import { captureLogger } from '../utils/loggerCapture';
import type Homey from 'homey';

const sinks = (overrides: Partial<PriceServiceLoggingSinks> = {}): PriceServiceLoggingSinks => ({
  log: () => {},
  debugStructured: () => {},
  ...overrides,
});

const buildIntervals = (startUtcMs: number, values: number[], intervalMinutes: number): HomeyEnergyPriceInterval[] => (
  values.map((value, index) => {
    const periodStart = new Date(startUtcMs + index * intervalMinutes * 60 * 1000).toISOString();
    const periodEnd = new Date(startUtcMs + (index + 1) * intervalMinutes * 60 * 1000).toISOString();
    return { periodStart, periodEnd, value };
  })
);

describe('Homey price service', () => {
  const timeZone = 'Europe/Oslo';
  const fixedNow = new Date(Date.UTC(2026, 0, 19, 12, 0, 0));

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores Homey energy prices and currency when scheme is homey', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const tomorrowKey = shiftDateKey(todayKey, 1);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);
    const tomorrowStartMs = getDateKeyStartMs(tomorrowKey, timeZone);

    const todayIntervals = buildIntervals(todayStartMs, [1.1, 2.2], 60);
    const tomorrowIntervals = buildIntervals(tomorrowStartMs, [3.3, 4.4], 60);

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockImplementation(async ({ date }) => {
        if (date === todayKey) {
          return { interval: 60, pricesPerInterval: todayIntervals, priceUnit: 'NOK' };
        }
        if (date === tomorrowKey) {
          return { interval: 60, pricesPerInterval: tomorrowIntervals, priceUnit: 'NOK' };
        }
        return { interval: 60, pricesPerInterval: [], priceUnit: 'NOK' };
      }),
      getCurrency: vi.fn().mockResolvedValue({ currency: 'NOK' }),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    const storedToday = mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY) as { dateKey?: string };
    const storedTomorrow = mockHomeyInstance.settings.get(HOMEY_PRICES_TOMORROW) as { dateKey?: string };
    const currency = mockHomeyInstance.settings.get(HOMEY_PRICES_CURRENCY);

    expect(storedToday?.dateKey).toBe(todayKey);
    expect(storedTomorrow?.dateKey).toBe(tomorrowKey);
    expect(currency).toBe('NOK');
    expect(energyApi.fetchDynamicElectricityPrices).toHaveBeenCalledWith({ date: todayKey });
    expect(energyApi.fetchDynamicElectricityPrices).toHaveBeenCalledWith({ date: tomorrowKey });
  });

  it('uses cached Homey price payloads when available', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const tomorrowKey = shiftDateKey(todayKey, 1);

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, { dateKey: todayKey, pricesByHour: { '0': 1 }, updatedAt: new Date().toISOString() });
    mockHomeyInstance.settings.set(HOMEY_PRICES_TOMORROW, { dateKey: tomorrowKey, pricesByHour: { '0': 2 }, updatedAt: new Date().toISOString() });

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockResolvedValue([]),
    };

    const debugStructured = vi.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured }),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(false);

    expect(energyApi.fetchDynamicElectricityPrices).not.toHaveBeenCalled();
    expect(debugStructured).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_energy_cache_used' }),
    );
  });

  it('logs when Homey energy API is unavailable', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const structuredLog = { info: vi.fn() };
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ structuredLog: structuredLog as unknown as PriceServiceLoggingSinks['structuredLog'] }),
      () => timeZone,
      () => null,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_energy_api_unavailable' }),
    );
  });

  it('logs an error when Homey price fetch fails', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const capture = captureLogger();
    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    expect(capture.findEvent('homey_prices_fetch_failed')).toMatchObject({ message: 'boom' });
    capture.restore();
  });

  it('stores only today and uses price unit when currency lookup fails', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);
    const todayIntervals = buildIntervals(todayStartMs, [1.1, 2.2], 60);

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockImplementation(async ({ date }) => {
        if (date === todayKey) {
          return { interval: 60, pricesPerInterval: todayIntervals, priceUnit: 'NOK' };
        }
        return { interval: 60, pricesPerInterval: [] };
      }),
      getCurrency: vi.fn().mockRejectedValue('nope'),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const debugStructured = vi.fn();
    const structuredLog = { info: vi.fn() };
    const capture = captureLogger();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured, structuredLog: structuredLog as unknown as PriceServiceLoggingSinks['structuredLog'] }),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    const currencyFailure = capture.findEvent('homey_energy_currency_fetch_failed');
    expect(currencyFailure).toBeDefined();
    expect((currencyFailure?.err as { message?: string } | undefined)?.message).toBe('nope');
    expect(debugStructured).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_energy_currency_fetch_failed' }),
    );
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY)).toBeTruthy();
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(HOMEY_PRICES_TOMORROW);
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_CURRENCY)).toBe('NOK');
    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_prices_stored', dayCount: 1 }),
    );
    capture.restore();
  });

  it('logs when no Homey price data is available', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const structuredLog = { info: vi.fn() };
    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockResolvedValue([]),
    };

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ structuredLog: structuredLog as unknown as PriceServiceLoggingSinks['structuredLog'] }),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_prices_no_data' }),
    );
  });

  it('ignores cached Homey data with mismatched date keys', () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const wrongKey = shiftDateKey(todayKey, -1);

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, {
      dateKey: wrongKey,
      pricesByHour: { '0': 1 },
      updatedAt: new Date().toISOString(),
    });

    const debugStructured = vi.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured }),
      () => timeZone,
      undefined,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    const prices = service.getCombinedHourlyPrices();

    expect(prices).toEqual([]);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_price_slot_rotated',
      priceSource: 'Homey prices',
      slot: 'today',
      action: 'cleared',
      from: wrongKey,
    }));
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY)).toBeNull();
  });

  it('promotes a stale Flow tomorrow payload dated today into the today slot', () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    // Tomorrow slot still holds yesterday's "tomorrow" payload, now dated today.
    const stalePayload = {
      dateKey: todayKey,
      pricesByHour: { '0': 1.1, '1': 2.2 },
      updatedAt: fixedNow.toISOString(),
    };
    mockHomeyInstance.settings.set(FLOW_PRICES_TOMORROW, stalePayload);

    const debugStructured = vi.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured }),
      () => timeZone,
      undefined,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    const prices = service.getCombinedHourlyPrices();

    expect(prices.length).toBeGreaterThan(0);
    expect(mockHomeyInstance.settings.get(FLOW_PRICES_TODAY)).toEqual(stalePayload);
    expect(mockHomeyInstance.settings.get(FLOW_PRICES_TOMORROW)).toBeNull();
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_price_slot_rotated',
      priceSource: 'Flow prices',
      action: 'promoted_to_today',
      from: todayKey,
    }));
  });

  it('promotes a stale Homey tomorrow payload dated today into the today slot', () => {
    // Regression: the Homey path used to wipe both slots at local midnight
    // before the next periodic refresh, dropping the daily-budget shaper back
    // to uniform (objective_missing_price_horizon). At the moment of rollover,
    // today still holds yesterday's payload and tomorrow holds today's — both
    // slots must rotate together, not be wiped.
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const yesterdayKey = shiftDateKey(todayKey, -1);

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const yesterdayPayload = {
      dateKey: yesterdayKey,
      pricesByHour: { '0': 9.9, '1': 8.8 },
      updatedAt: fixedNow.toISOString(),
    };
    const stalePayload = {
      dateKey: todayKey,
      pricesByHour: { '0': 1.1, '1': 2.2 },
      updatedAt: fixedNow.toISOString(),
    };
    mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, yesterdayPayload);
    mockHomeyInstance.settings.set(HOMEY_PRICES_TOMORROW, stalePayload);
    // This spec is about slot rotation: the owner has no price formula, so the
    // stored prices are the prices.
    mirrorNoHomeyPriceFormula(mockHomeyInstance.settings);

    const debugStructured = vi.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured }),
      () => timeZone,
      undefined,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    const prices = service.getCombinedHourlyPrices();

    expect(prices.length).toBeGreaterThan(0);
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY)).toEqual(stalePayload);
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TOMORROW)).toBeNull();
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_price_slot_rotated',
      priceSource: 'Homey prices',
      action: 'promoted_to_today',
      from: todayKey,
    }));
  });

  it('persists refreshed lastFetched when combined prices are otherwise unchanged', () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
      dateKey: todayKey,
      pricesByHour: { '0': 1.5, '1': 1.7 },
      updatedAt: fixedNow.toISOString(),
    });

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      undefined,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    service.updateCombinedPrices();
    vi.advanceTimersByTime(1000);
    service.updateCombinedPrices();

    const combinedWrites = setSpy.mock.calls.filter(([key]) => key === COMBINED_PRICES);
    expect(combinedWrites).toHaveLength(2);
    const firstPayload = combinedWrites[0][1] as { lastFetched?: string };
    const secondPayload = combinedWrites[1][1] as { lastFetched?: string };
    expect(firstPayload.lastFetched).toBe(fixedNow.toISOString());
    expect(secondPayload.lastFetched).toBe(new Date(fixedNow.getTime() + 1000).toISOString());
    expect(mockHomeyInstance.api._realtimeEvents.filter((event) => event.event === 'prices_updated')).toHaveLength(2);
  });

  it('rewrites combined prices when underlying values change', () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
      dateKey: todayKey,
      pricesByHour: { '0': 1.5, '1': 1.7 },
      updatedAt: fixedNow.toISOString(),
    });

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      undefined,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    service.updateCombinedPrices();

    mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
      dateKey: todayKey,
      pricesByHour: { '0': 2.5, '1': 2.7 },
      updatedAt: new Date(fixedNow.getTime() + 1000).toISOString(),
    });
    vi.advanceTimersByTime(1000);
    service.updateCombinedPrices();

    const combinedWrites = setSpy.mock.calls.filter(([key]) => key === COMBINED_PRICES);
    expect(combinedWrites).toHaveLength(2);
    expect(mockHomeyInstance.api._realtimeEvents.filter((event) => event.event === 'prices_updated')).toHaveLength(2);
  });

  // A zone on the 15-minute market publishes four prices per hour. Everything
  // downstream of `getCombinedHourlyPrices` reasons in whole hours, so what it
  // sees must stay exactly what an hourly zone would have published — the
  // quarters are averaged in the producer, not read as whole hours by accident.
  it('serves a 15-minute zone as the hourly prices an hourly zone would give', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);

    // Two hours of quarters: hour 0 averages to 4, hour 1 to 16.
    const quarterValues = [1, 3, 5, 7, 10, 14, 18, 22];
    const quarterIntervals = buildIntervals(todayStartMs, quarterValues, 15);
    // Every quarter arrives twice, the way the live API sends it.
    const doubled = quarterIntervals.flatMap((interval) => [interval, { ...interval }]);

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockImplementation(async ({ date }) => (
        date === todayKey
          ? { interval: 15, pricesPerInterval: doubled, priceUnit: 'NOK' }
          : { interval: 15, pricesPerInterval: [], priceUnit: 'NOK' }
      )),
      getCurrency: vi.fn().mockResolvedValue({ currency: 'NOK' }),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY) as {
      pricesBySlot?: Array<{ durationMinutes?: number }>;
      pricesByPeriod?: Array<{ durationMinutes?: number }>;
    };
    // Stored at the source's own resolution, deduplicated...
    expect(stored.pricesByPeriod).toHaveLength(quarterValues.length);
    expect(stored.pricesByPeriod?.every((period) => period.durationMinutes === 15)).toBe(true);
    // ...alongside the hourly series an older app build reads, which is stored
    // without a duration because an hour is what a period with none means.
    expect(stored.pricesBySlot).toHaveLength(2);
    expect(stored.pricesBySlot?.every((period) => period.durationMinutes === undefined)).toBe(true);

    const hourly = service.getCombinedHourlyPrices();
    expect(hourly).toEqual([
      { startsAt: new Date(todayStartMs).toISOString(), totalPrice: 4 },
      { startsAt: new Date(todayStartMs + 3_600_000).toISOString(), totalPrice: 16 },
    ]);
  });

  // What the owner actually feels: the level follows the quarter in force, so a
  // cheap quarter inside an ordinary hour reaches the thermostats while it lasts.
  it('follows the current quarter when classifying the price level', async () => {
    const noon = new Date(Date.UTC(2026, 0, 19, 12, 0, 0));
    vi.useFakeTimers().setSystemTime(noon);
    const todayKey = getDateKeyInTimeZone(noon, timeZone);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);

    // A flat day at 10, except one quarter of hour 12 priced at 1.
    const quarterValues = Array.from({ length: 96 }, (_, index) => (index === 4 * 13 + 2 ? 1 : 10));
    const intervals = buildIntervals(todayStartMs, quarterValues, 15);
    const cheapQuarterStartMs = todayStartMs + (4 * 13 + 2) * 15 * 60_000;

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockImplementation(async ({ date }) => (
        date === todayKey
          ? { interval: 15, pricesPerInterval: intervals, priceUnit: 'NOK' }
          : { interval: 15, pricesPerInterval: [], priceUnit: 'NOK' }
      )),
      getCurrency: vi.fn().mockResolvedValue({ currency: 'NOK' }),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    mockHomeyInstance.settings.set('price_threshold_percent', 25);

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);

    vi.setSystemTime(new Date(cheapQuarterStartMs + 60_000));
    expect(service.getCurrentHourPriceLevel()).toBe(PriceLevel.CHEAP);
    expect(service.getCurrentHourStartMs()).toBe(cheapQuarterStartMs);

    // The next quarter is back to the flat price, and the level says so at once.
    vi.setSystemTime(new Date(cheapQuarterStartMs + 15 * 60_000 + 60_000));
    expect(service.getCurrentHourPriceLevel()).toBe(PriceLevel.NORMAL);

    // The hourly series the rest of PELS reads still averages that hour.
    const hourOfTheCheapQuarter = service.getCombinedHourlyPrices()
      .find((entry) => Date.parse(entry.startsAt) === todayStartMs + 13 * 3_600_000);
    expect(hourOfTheCheapQuarter?.totalPrice).toBeCloseTo(7.75);
  });

  // The whole day, on the day the clock goes back: 25 hours, 100 quarters, and
  // the repeated 02:00 hour priced twice — once for each hour it actually was.
  it('gives a 15-minute zone 25 separate hours on the fall-back day', async () => {
    const fallBackNoon = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));
    vi.useFakeTimers().setSystemTime(fallBackNoon);
    const todayKey = getDateKeyInTimeZone(fallBackNoon, timeZone);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);

    // Quarter n is priced n, so each hour averages to its own distinct value.
    const quarterValues = Array.from({ length: 100 }, (_, index) => index);
    const quarterIntervals = buildIntervals(todayStartMs, quarterValues, 15);

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockImplementation(async ({ date }) => (
        date === todayKey
          ? { interval: 15, pricesPerInterval: quarterIntervals, priceUnit: 'NOK' }
          : { interval: 15, pricesPerInterval: [], priceUnit: 'NOK' }
      )),
      getCurrency: vi.fn().mockResolvedValue({ currency: 'NOK' }),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      () => energyApi,
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      noHomeyWebApi,
    );

    await service.refreshSpotPrices(true);
    const hourly = service.getCombinedHourlyPrices();

    expect(hourly).toHaveLength(25);
    // Each hour is the mean of its own four quarters: 1.5, 5.5, 9.5, …
    expect(hourly.map((entry) => entry.totalPrice)).toEqual(
      Array.from({ length: 25 }, (_, hour) => hour * 4 + 1.5),
    );
    // The two 02:00 hours are separate hours with separate prices.
    const repeatedClockHour = hourly.filter((entry) => (
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false })
        .format(new Date(entry.startsAt)) === '02'
    ));
    expect(repeatedClockHour).toHaveLength(2);
    expect(repeatedClockHour[0].totalPrice).not.toBe(repeatedClockHour[1].totalPrice);
  });

  describe("the owner's Homey price formula", () => {
    // Homey publishes RAW SPOT per interval and keeps the owner's tariff, taxes
    // and VAT in a separate expression it applies only inside its own features.
    // These specs pin what PELS does with that expression, because planning
    // against unresolved spot is planning against a price nobody pays.
    const storeTodayPrices = (values: Record<string, number>): void => {
      const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
      mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, {
        dateKey: todayKey,
        pricesByHour: values,
        updatedAt: fixedNow.toISOString(),
      });
    };

    /**
     * Answer the user-costs route the way Homey does: the option's value, or
     * `null` when the owner has configured no formula. A throw stands in for
     * every failure — the transport surfaces no status this read can use.
     */
    type FormulaAnswer = { expression: string } | 'none' | 'fails' | 'missing-route' | 'malformed';

    const serveFormula = (answer: FormulaAnswer): HomeyWebApiGet => (
      async (path: string) => {
        if (path !== PRICE_USER_COSTS_API_PATH) throw new Error(`unexpected path ${path}`);
        // A transient failure and a 404 arrive the same way and are told apart
        // by status alone, exactly as the REST client surfaces them.
        if (answer === 'fails') throw new HomeyHttpStatusError(500, 'Internal Server Error');
        if (answer === 'missing-route') throw new HomeyHttpStatusError(404, 'Cannot GET');
        if (answer === 'malformed') return { error: 'partial response' };
        if (answer === 'none') return null;
        return { mathExpression: answer.expression, type: 'tariff_and_tax_math_expression' };
      }
    );

    const createService = (
      homeyWebApiGet: HomeyWebApiGet,
      overrides: Partial<PriceServiceLoggingSinks> = {},
    ): PriceService => new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(overrides),
      () => timeZone,
      () => ({ fetchDynamicElectricityPrices: vi.fn().mockResolvedValue([]) }),
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      homeyWebApiGet,
    );

    it('prices every hour through the formula the owner configured', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      const service = createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' }));

      await service.refreshSpotPrices(true);

      const prices = service.getCombinedHourlyPrices();
      expect(prices.map((price) => price.totalPrice)).toEqual([1.75, 3]);
    });

    it('leaves raw spot alone when the owner has configured no formula', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      const service = createService(serveFormula('none'));

      await service.refreshSpotPrices(true);

      expect(service.getCombinedHourlyPrices().map((price) => price.totalPrice)).toEqual([1, 2]);
    });

    it('publishes no prices at all when the formula cannot be evaluated', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      // Wholesale spot is always lower than what the owner pays, so presenting
      // it as their price would be a plausible-looking lie; no price is honest.
      const service = createService(serveFormula({ expression: '{{ max([[price]], 0) }}' }));

      await service.refreshSpotPrices(true);

      expect(service.getCombinedHourlyPrices()).toEqual([]);
    });

    it('keeps pricing on the last known formula when the read fails', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1 });
      await createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' })).refreshSpotPrices(true);

      const failing = createService(serveFormula('fails'));
      await failing.refreshSpotPrices(true);

      expect(failing.getCombinedHourlyPrices().map((price) => price.totalPrice)).toEqual([1.75]);
    });

    it('stops applying a formula the owner has removed', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1 });
      await createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' })).refreshSpotPrices(true);

      const cleared = createService(serveFormula('none'));
      await cleared.refreshSpotPrices(true);

      expect(cleared.getCombinedHourlyPrices().map((price) => price.totalPrice)).toEqual([1]);
    });

    it('keeps persisted prices when the formula has never been read', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      // An upgrade that priced raw before this existed, whose first read fails.
      // We cannot price now, but nothing here says the stored prices are wrong
      // — and blanking them would also blank a home the moment its owner picks
      // this price source, which rebuilds derived state without reading.
      mockHomeyInstance.settings.set(COMBINED_PRICES, {
        version: 2,
        days: { [getDateKeyInTimeZone(fixedNow, timeZone)]: { hours: [{ startsAt: fixedNow.toISOString(), total: 1, isCheap: false, isExpensive: false }] } },
      });

      await createService(serveFormula('fails')).refreshSpotPrices(true);

      const persisted = mockHomeyInstance.settings.get(COMBINED_PRICES) as { days?: Record<string, { hours?: unknown[] }> };
      expect(Object.values(persisted?.days ?? {}).flatMap((day) => day.hours ?? [])).not.toEqual([]);
    });

    it('publishes no prices when the formula has never been read', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      // A fresh install, or an upgrade, whose very first read fails: nothing is
      // mirrored yet, so how this home prices electricity is UNKNOWN. Passing
      // raw wholesale spot through here is the exact bug this file fixes, and
      // an absent mirror must not be read as "the owner has no formula".
      const service = createService(serveFormula('fails'));

      await service.refreshSpotPrices(true);

      expect(service.getCombinedHourlyPrices()).toEqual([]);
    });

    it('prices off raw spot on firmware with no user-cost route', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      // A 404 is the one failure that settles the question: this firmware has
      // no user costs to apply, so the raw price IS the owner's price.
      const service = createService(serveFormula('missing-route'));

      await service.refreshSpotPrices(true);

      expect(service.getCombinedHourlyPrices().map((price) => price.totalPrice)).toEqual([1, 2]);
    });

    it('keeps the mirrored formula when the route answers with a malformed body', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1 });
      await createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' })).refreshSpotPrices(true);

      // A partial or error-shaped 200 says nothing about the owner's
      // configuration; only a literal `null` means they removed the formula.
      const malformed = createService(serveFormula('malformed'));
      await malformed.refreshSpotPrices(true);

      expect(malformed.getCombinedHourlyPrices().map((price) => price.totalPrice)).toEqual([1.75]);
    });

    it('drops persisted prices when the formula becomes unevaluable', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      await createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' })).refreshSpotPrices(true);
      expect(mockHomeyInstance.settings.get(COMBINED_PRICES)).toBeTruthy();

      // The live service reports no prices; the persisted payload must not go
      // on serving prices built from a formula that no longer applies — the
      // daily budget, smart-task horizons, Flow tags and UI all read it.
      const unevaluable = createService(serveFormula({ expression: '{{ max([[price]], 0) }}' }));
      await unevaluable.refreshSpotPrices(true);

      const persisted = mockHomeyInstance.settings.get(COMBINED_PRICES) as { days?: Record<string, unknown> };
      const persistedEntries = Object.values(persisted?.days ?? {})
        .flatMap((day) => (day as { hours?: unknown[] }).hours ?? []);
      expect(persistedEntries).toEqual([]);
    });

    it('keeps persisted prices when the mirrored formula reads back empty', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      await createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' })).refreshSpotPrices(true);
      const persistedBefore = mockHomeyInstance.settings.get(COMBINED_PRICES);

      // The SDK hands back nothing for a key it still lists — a transient miss
      // this platform does produce. That settles nothing about the home, so it
      // must not be read as "never configured" and used to bin good prices.
      const get = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
      vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
        key === HOMEY_PRICE_FORMULA ? undefined : get(key)
      ));
      createService(serveFormula('fails')).updateCombinedPrices();
      vi.mocked(mockHomeyInstance.settings.get).mockRestore();

      expect(mockHomeyInstance.settings.get(COMBINED_PRICES)).toEqual(persistedBefore);
    });

    it('drops persisted prices when a compiled formula prices nothing', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1, '14': 2 });
      await createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' })).refreshSpotPrices(true);

      // This one parses, so it is not `unsupported` — but it evaluates
      // non-finite at every period, so the home has no prices. The verdict has
      // to come from what the formula actually produced, not from the fact
      // that it compiled.
      const pricesNothing = createService(serveFormula({ expression: '{{ 1 / ([[price]] - [[price]]) }}' }));
      await pricesNothing.refreshSpotPrices(true);

      expect(pricesNothing.getCombinedHourlyPrices()).toEqual([]);
      const persisted = mockHomeyInstance.settings.get(COMBINED_PRICES) as { days?: Record<string, unknown> };
      const persistedEntries = Object.values(persisted?.days ?? {})
        .flatMap((day) => (day as { hours?: unknown[] }).hours ?? []);
      expect(persistedEntries).toEqual([]);
    });

    it('recovers once a later read answers with the formula', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1 });
      await createService(serveFormula('missing-route')).refreshSpotPrices(true);
      expect(mockHomeyInstance.settings.get(HOMEY_PRICE_FORMULA)).toEqual({ mathExpression: null });

      // Firmware updated, or the owner configured costs: the mirror must move
      // off its recorded "no formula" the first time a read says otherwise.
      const configured = createService(serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' }));
      await configured.refreshSpotPrices(true);

      expect(configured.getCombinedHourlyPrices().map((price) => price.totalPrice)).toEqual([1.75]);
    });

    it('does not rewrite the mirrored formula when it has not changed', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeTodayPrices({ '13': 1 });
      const formula = serveFormula({ expression: '{{ (0.4 + [[price]]) * 1.25 }}' });
      await createService(formula).refreshSpotPrices(true);

      expect(mockHomeyInstance.settings.get(HOMEY_PRICE_FORMULA))
        .toEqual({ mathExpression: '{{ (0.4 + [[price]]) * 1.25 }}' });
      // An earlier spec in this file spies on the same method and nothing
      // restores it, so vi.spyOn hands back that spy with its calls already on
      // it; only the writes from here on are this spec's business.
      const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
      setSpy.mockClear();
      await createService(formula).refreshSpotPrices(true);

      // Every settings write ships the whole settings object to core; this key
      // is re-read every three hours and changes about never.
      expect(setSpy.mock.calls.filter(([key]) => key === HOMEY_PRICE_FORMULA)).toHaveLength(0);
    });
  });
  describe("Homey's own export price", () => {
    // The owner picks where the feed-in price comes from, the same way they
    // pick the import price source. These specs pin what PELS does once they
    // point it at Homey: terms Homey already holds, applied per period, with
    // nothing retyped into PELS.
    const serveExport = (type: string, body?: unknown): HomeyWebApiGet => (
      async (path: string) => {
        if (path === PRICE_USER_COSTS_API_PATH) return null;
        if (path === EXPORT_TYPE_API_PATH) return type;
        if (path === EXPORT_FIXED_OPTION_API_PATH || path === EXPORT_USER_COSTS_API_PATH) return body;
        throw new Error(`unexpected path ${path}`);
      }
    );

    const createService = (webApiGet: HomeyWebApiGet): PriceService => new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks(),
      () => timeZone,
      () => ({ fetchDynamicElectricityPrices: vi.fn().mockResolvedValue([]) }),
      createPriceDataStore(mockHomeyInstance.settings),
      () => ({}),
      webApiGet,
    );

    const storeHomeyPrices = (values: Record<string, number>): void => {
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
      mockHomeyInstance.settings.set(EXPORT_PRICE_SOURCE, 'homey_energy');
      mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
      mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, {
        dateKey: getDateKeyInTimeZone(fixedNow, timeZone),
        pricesByHour: values,
        updatedAt: fixedNow.toISOString(),
      });
    };

    it('pays a fixed feed-in tariff on every period', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1, '14': 2 });
      const service = createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }));

      await service.refreshSpotPrices(true);

      expect(service.getCombinedHourlyPrices().map((price) => price.exportPrice)).toEqual([0.3, 0.3]);
    });

    it('prices a dynamic export formula against the all-in import price', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1, '14': 2 });
      // No import formula here, so the import price is the raw value — and
      // `[[importPrice]]` must see that same number, not the bare spot by
      // accident.
      const service = createService(serveExport('dynamic', { mathExpression: '{{ [[importPrice]] - 0.1 }}' }));

      await service.refreshSpotPrices(true);

      const prices = service.getCombinedHourlyPrices();
      expect(prices.map((price) => price.exportPrice)).toEqual([0.9, 1.9]);
    });

    it('keeps the owner paid nothing when Homey says export is disabled', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1 });
      const service = createService(serveExport('disabled'));

      await service.refreshSpotPrices(true);

      expect(service.getCombinedHourlyPrices()[0]?.exportPrice).toBeUndefined();
    });

    it("ignores Homey's terms while the owner's own amounts are the source", async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1 });
      // The default, and what every existing home has: PELS must not start
      // paying Homey's number because it happens to be readable.
      mockHomeyInstance.settings.set(EXPORT_PRICE_SOURCE, 'manual');
      mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 0);
      mockHomeyInstance.settings.set(EXPORT_FIXED, 0.07);
      const webApiGet = vi.fn(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }));
      const service = createService(webApiGet);

      await service.refreshSpotPrices(true);

      // Their own 0.07, not Homey's 0.30 — and Homey was never even asked.
      expect(service.getCombinedHourlyPrices()[0]?.exportPrice).toBe(0.07);
      expect(webApiGet.mock.calls.map(([path]) => path)).not.toContain(EXPORT_TYPE_API_PATH);
    });

    it('pays nothing once the owner turns export pricing off', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1 });
      const service = createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }));
      await service.refreshSpotPrices(true);

      // The selector says WHERE the price comes from; the master toggle says
      // WHETHER the owner is paid at all, and it has to outrank the source.
      mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, false);

      expect(service.getCombinedHourlyPrices()[0]?.exportPrice).toBeUndefined();
    });

    it("leaves the owner's own amounts in charge on another price source", async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1 });
      await createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }))
        .refreshSpotPrices(true);

      // Only the Homey series carries Homey's feed-in price. Switching import
      // scheme must not leave the manual fields visible but powerless.
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
      mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
        dateKey: getDateKeyInTimeZone(fixedNow, timeZone),
        pricesByHour: { '13': 1 },
        updatedAt: fixedNow.toISOString(),
      });
      mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 0);
      mockHomeyInstance.settings.set(EXPORT_FIXED, 0.07);
      const onFlow = createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }));

      expect(onFlow.getCombinedHourlyPrices()[0]?.exportPrice).toBe(0.07);
    });

    it('persists nothing when the mirrored terms read back empty', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1 });
      await createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }))
        .refreshSpotPrices(true);
      const persistedBefore = mockHomeyInstance.settings.get(COMBINED_PRICES);

      // A listed key the SDK does not hand back settles nothing; dropping the
      // feed-in price out of the stored series would make a hiccup durable.
      const get = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
      vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
        key === HOMEY_EXPORT_PRICE_TERMS ? undefined : get(key)
      ));
      createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }))
        .updateCombinedPrices();
      vi.mocked(mockHomeyInstance.settings.get).mockRestore();

      expect(mockHomeyInstance.settings.get(COMBINED_PRICES)).toEqual(persistedBefore);
    });

    it('keeps the last known terms when the export read fails', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      storeHomeyPrices({ '13': 1 });
      await createService(serveExport('fixed', { value: { costs: { user_fixed_base: { value: 0.3 } } } }))
        .refreshSpotPrices(true);

      const failing = createService(async (path: string) => {
        if (path === PRICE_USER_COSTS_API_PATH) return null;
        throw new HomeyHttpStatusError(500, 'boom');
      });
      await failing.refreshSpotPrices(true);

      expect(failing.getCombinedHourlyPrices().map((price) => price.exportPrice)).toEqual([0.3]);
    });
  });
});
