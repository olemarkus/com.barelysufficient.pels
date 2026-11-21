import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey } from '../../mocks/homey';
import { PriceCoordinator } from '../../../lib/price/priceCoordinator';
import { createPriceOptimizationSettingsStore } from '../../../lib/price/priceOptimizationSettingsStore';
import { createPriceDataStore } from '../../../lib/price/priceDataStore';
import { createInMemoryPriceCache } from '../../helpers/priceCacheForTests';
import { HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW, PRICE_SCHEME } from '../../../lib/utils/settingsKeys';
import { noHomeyWebApi, unknownHubMarket } from '../../helpers/homeyWebApiStub';
import { testLogger } from '../../utils/testLogger';

const HALF_HOUR_MS = 30 * 60 * 1000;

let priceCache = createInMemoryPriceCache();

const createCoordinator = () => new PriceCoordinator({
  structuredLog: testLogger,
  homey: mockHomeyInstance as never,
  priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(mockHomeyInstance.settings),
  priceDataStore: createPriceDataStore(mockHomeyInstance.settings, priceCache),
  getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
  getPowerTracker: () => ({}),
  homeyWebApiGet: noHomeyWebApi,
  readHubMarket: unknownHubMarket,
  readHubLocation: async () => ({ kind: 'unavailable' }),
  error: () => undefined,
});

const storeDay = (key: typeof HOMEY_PRICES_TODAY | typeof HOMEY_PRICES_TOMORROW, dateKey: string) => {
  priceCache.write(key, { dateKey, pricesByHour: { '0': 1 }, updatedAt: new Date().toISOString() });
};

// The mock hub runs on Europe/Oslo (CET, UTC+1 in November).
describe('PriceCoordinator next-day retry on the Homey source', () => {
  beforeEach(() => {
    priceCache = createInMemoryPriceCache();
    resetMockHomey();
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks again every half hour while tomorrow is due, and stops once it is stored', () => {
    // 15:32 local on 2026-11-20, today stored, tomorrow not.
    vi.useFakeTimers().setSystemTime(new Date('2026-11-20T14:32:00.000Z'));
    storeDay(HOMEY_PRICES_TODAY, '2026-11-20');
    const coordinator = createCoordinator();
    const refreshSpy = vi.spyOn(coordinator, 'refreshSpotPrices').mockResolvedValue(undefined);

    coordinator.startPriceRefresh();
    vi.advanceTimersByTime(HALF_HOUR_MS);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HALF_HOUR_MS);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    storeDay(HOMEY_PRICES_TOMORROW, '2026-11-21');
    vi.advanceTimersByTime(2 * HALF_HOUR_MS);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    coordinator.stop();
  });

  it('waits for the three-hourly cycle before the next day is due', () => {
    // 10:00 local: tomorrow's prices are not published yet.
    vi.useFakeTimers().setSystemTime(new Date('2026-11-20T09:00:00.000Z'));
    storeDay(HOMEY_PRICES_TODAY, '2026-11-20');
    const coordinator = createCoordinator();
    const refreshSpy = vi.spyOn(coordinator, 'refreshSpotPrices').mockResolvedValue(undefined);

    coordinator.startPriceRefresh();
    vi.advanceTimersByTime(4 * HALF_HOUR_MS);
    expect(refreshSpy).not.toHaveBeenCalled();

    coordinator.stop();
  });

  it('treats a stored next day from an earlier date as outstanding', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-20T14:32:00.000Z'));
    storeDay(HOMEY_PRICES_TODAY, '2026-11-20');
    storeDay(HOMEY_PRICES_TOMORROW, '2026-11-20');
    const coordinator = createCoordinator();
    const refreshSpy = vi.spyOn(coordinator, 'refreshSpotPrices').mockResolvedValue(undefined);

    coordinator.startPriceRefresh();
    vi.advanceTimersByTime(HALF_HOUR_MS);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('does not retry on another price source', () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    vi.useFakeTimers().setSystemTime(new Date('2026-11-20T14:32:00.000Z'));
    const coordinator = createCoordinator();
    const refreshSpy = vi.spyOn(coordinator, 'refreshSpotPrices').mockResolvedValue(undefined);

    coordinator.startPriceRefresh();
    vi.advanceTimersByTime(4 * HALF_HOUR_MS);
    expect(refreshSpy).not.toHaveBeenCalled();

    coordinator.stop();
  });

  it('stop() clears the retry', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-20T14:32:00.000Z'));
    storeDay(HOMEY_PRICES_TODAY, '2026-11-20');
    const coordinator = createCoordinator();
    const refreshSpy = vi.spyOn(coordinator, 'refreshSpotPrices').mockResolvedValue(undefined);

    coordinator.startPriceRefresh();
    coordinator.stop();
    vi.advanceTimersByTime(4 * HALF_HOUR_MS);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
