import PriceService from '../lib/price/priceService';
import { mockHomeyInstance } from './mocks/homey';
import {
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  PRICE_SCHEME,
} from '../lib/utils/settingsKeys';
import { getDateKeyInTimeZone, getDateKeyStartMs } from '../lib/utils/dateUtils';
import type { HomeyEnergyApi, HomeyEnergyPriceInterval } from '../lib/utils/homeyEnergy';
import type Homey from 'homey';

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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores Homey energy prices and currency when scheme is homey', async () => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const tomorrowKey = getDateKeyInTimeZone(new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000), timeZone);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);
    const tomorrowStartMs = getDateKeyStartMs(tomorrowKey, timeZone);

    const todayIntervals = buildIntervals(todayStartMs, [1.1, 2.2], 60);
    const tomorrowIntervals = buildIntervals(tomorrowStartMs, [3.3, 4.4], 60);

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: jest.fn().mockImplementation(async ({ date }) => {
        if (date === todayKey) {
          return { interval: 60, pricesPerInterval: todayIntervals, priceUnit: 'NOK' };
        }
        if (date === tomorrowKey) {
          return { interval: 60, pricesPerInterval: tomorrowIntervals, priceUnit: 'NOK' };
        }
        return { interval: 60, pricesPerInterval: [], priceUnit: 'NOK' };
      }),
      getCurrency: jest.fn().mockResolvedValue({ currency: 'NOK' }),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      () => {},
      () => {},
      () => {},
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
    jest.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const tomorrowKey = getDateKeyInTimeZone(new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000), timeZone);

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, { dateKey: todayKey, pricesByHour: { '0': 1 }, updatedAt: new Date().toISOString() });
    mockHomeyInstance.settings.set(HOMEY_PRICES_TOMORROW, { dateKey: tomorrowKey, pricesByHour: { '0': 2 }, updatedAt: new Date().toISOString() });

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: jest.fn().mockResolvedValue([]),
    };

    const logDebug = jest.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      () => {},
      logDebug,
      () => {},
      () => energyApi,
    );

    await service.refreshSpotPrices(false);

    expect(energyApi.fetchDynamicElectricityPrices).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith('Homey prices: Using cached data');
  });

  it('logs when Homey energy API is unavailable', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const log = jest.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      log,
      () => {},
      () => {},
      () => null,
    );

    await service.refreshSpotPrices(true);

    expect(log).toHaveBeenCalledWith('Homey prices: Homey energy API not available');
  });

  it('logs an error when Homey price fetch fails', async () => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const errorLog = jest.fn();
    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: jest.fn().mockRejectedValue(new Error('boom')),
    };

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      () => {},
      () => {},
      errorLog,
      () => energyApi,
    );

    await service.refreshSpotPrices(true);

    expect(errorLog).toHaveBeenCalledWith('Homey prices: Failed to fetch price data', expect.any(Error));
  });

  it('stores only today and uses price unit when currency lookup fails', async () => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const todayStartMs = getDateKeyStartMs(todayKey, timeZone);
    const todayIntervals = buildIntervals(todayStartMs, [1.1, 2.2], 60);

    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: jest.fn().mockImplementation(async ({ date }) => {
        if (date === todayKey) {
          return { interval: 60, pricesPerInterval: todayIntervals, priceUnit: 'NOK' };
        }
        return { interval: 60, pricesPerInterval: [] };
      }),
      getCurrency: jest.fn().mockRejectedValue(new Error('nope')),
    };

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const log = jest.fn();
    const logDebug = jest.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      log,
      logDebug,
      () => {},
      () => energyApi,
    );

    await service.refreshSpotPrices(true);

    expect(logDebug).toHaveBeenCalledWith('Homey prices: Failed to fetch currency', expect.any(Error));
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TODAY)).toBeTruthy();
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_TOMORROW)).toBeUndefined();
    expect(mockHomeyInstance.settings.get(HOMEY_PRICES_CURRENCY)).toBe('NOK');
    expect(log).toHaveBeenCalledWith('Homey prices: Stored 1 day of price data');
  });

  it('logs when no Homey price data is available', async () => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    const log = jest.fn();
    const energyApi: HomeyEnergyApi = {
      fetchDynamicElectricityPrices: jest.fn().mockResolvedValue([]),
    };

    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      log,
      () => {},
      () => {},
      () => energyApi,
    );

    await service.refreshSpotPrices(true);

    expect(log).toHaveBeenCalledWith('Homey prices: No price data available');
  });

  it('ignores cached Homey data with mismatched date keys', () => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
    const wrongKey = getDateKeyInTimeZone(new Date(fixedNow.getTime() - 24 * 60 * 60 * 1000), timeZone);

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    mockHomeyInstance.settings.set(HOMEY_PRICES_TODAY, {
      dateKey: wrongKey,
      pricesByHour: { '0': 1 },
      updatedAt: new Date().toISOString(),
    });

    const logDebug = jest.fn();
    const service = new PriceService(
      mockHomeyInstance as unknown as Homey.App['homey'],
      () => {},
      logDebug,
      () => {},
    );

    const prices = service.getCombinedHourlyPrices();

    expect(prices).toEqual([]);
    expect(logDebug).toHaveBeenCalledWith(
      `Homey prices: Ignoring stored today data for ${wrongKey} (expected ${todayKey})`,
    );
  });
});
