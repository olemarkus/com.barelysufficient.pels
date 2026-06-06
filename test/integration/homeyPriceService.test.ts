import PriceService from '../../lib/price/priceService';
import type { PriceServiceLoggingSinks } from '../../lib/price/priceServiceLoggingSinks';
import { mockHomeyInstance } from '../mocks/homey';
import {
  COMBINED_PRICES,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';
import { getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey } from '../../lib/utils/dateUtils';
import type { HomeyEnergyApi, HomeyEnergyPriceInterval } from '../../lib/utils/homeyEnergy';
import type { Logger } from '../../lib/logging/logger';
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
      () => energyApi,
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
      () => energyApi,
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
      sinks({ structuredLog: structuredLog as unknown as Logger }),
      () => null,
    );

    await service.refreshSpotPrices(true);

    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_energy_api_unavailable' }),
    );
  });

  it('logs an error when Homey price fetch fails', async () => {
    vi.useFakeTimers().setSystemTime(fixedNow);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const errorLog = vi.fn();
    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ errorLog }),
      () => energyApi,
    );

    await service.refreshSpotPrices(true);

    const messages = errorLog.mock.calls.map((call) => call[0]);
    expect(messages.some((message) => String(message).includes('Failed to fetch price data for'))).toBe(true);
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
    const errorLog = vi.fn();
    const structuredLog = { info: vi.fn() };
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured, errorLog, structuredLog: structuredLog as unknown as Logger }),
      () => energyApi,
    );

    await service.refreshSpotPrices(true);

    expect(errorLog).toHaveBeenCalledWith('Homey prices: Failed to fetch currency', expect.any(Error));
    const currencyError = errorLog.mock.calls.find(([message]) => message === 'Homey prices: Failed to fetch currency')?.[1];
    expect((currencyError as Error).message).toBe('nope');
    expect(debugStructured).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_energy_currency_fetch_failed' }),
    );
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY)).toBeTruthy();
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TOMORROW)).toBeUndefined();
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_CURRENCY)).toBe('NOK');
    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'homey_prices_stored', dayCount: 1 }),
    );
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
      sinks({ structuredLog: structuredLog as unknown as Logger }),
      () => energyApi,
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

    const debugStructured = vi.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      sinks({ debugStructured }),
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
});
