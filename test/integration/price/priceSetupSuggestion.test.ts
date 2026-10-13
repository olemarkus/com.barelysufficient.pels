import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockApiApp } from '../../mocks/homey';
import { PriceCoordinator } from '../../../lib/price/priceCoordinator';
import { createPriceOptimizationSettingsStore } from '../../../lib/price/priceOptimizationSettingsStore';
import { createPriceDataStore } from '../../../lib/price/priceDataStore';
import { POWERHOUR_APP_ID } from '../../../lib/price/powerhourPriceFetch';
import { createInMemoryPriceCache } from '../../helpers/priceCacheForTests';
import { homeyWebApiServing, hubMarketIn } from '../../helpers/homeyWebApiStub';

const POWERHOUR_DEVICE = {
  deviceId: '10YNL----------L_abc',
  deviceName: 'NL',
  driverType: 'dap',
  biddingZone: '10YNL----------L',
  currency: '€',
  priceInterval: 60,
  slots: [{ time: '2026-10-13T10:00:00.000Z', importPrice: 0.21, exportPrice: 0, isForecast: false }],
};

const createCoordinator = (country = 'NL') => {
  const readHubLocation = vi.fn(async () => ({
    kind: 'resolved' as const, coordinates: { latitude: 52.37, longitude: 4.9 },
  }));
  const coordinator = new PriceCoordinator({
    homey: mockHomeyInstance as never,
    priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(mockHomeyInstance.settings),
    priceDataStore: createPriceDataStore(mockHomeyInstance.settings, createInMemoryPriceCache()),
    getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
    getPowerTracker: () => ({}),
    homeyWebApiGet: homeyWebApiServing({}).get,
    readHubMarket: hubMarketIn(country),
    readHubLocation,
    log: () => undefined,
    debugStructured: () => undefined,
    error: () => undefined,
  });
  return { coordinator, readHubLocation };
};

describe('price setup suggestion, by source in force', () => {
  const powerhourGet = vi.fn(async () => ({ prices: [POWERHOUR_DEVICE] }));

  beforeEach(() => {
    resetMockHomey();
    powerhourGet.mockClear();
    mockHomeyInstance.settings.set('capacity_limit_kw', 8);
    setMockApiApp(POWERHOUR_APP_ID, { installed: true, get: powerhourGet });
  });

  it('on Homey Energy, says Power by the Hour has a price device, and sends the location nowhere', async () => {
    mockHomeyInstance.settings.set('price_scheme', 'homey');
    const { coordinator, readHubLocation } = createCoordinator();

    await expect(coordinator.suggestPriceSetup()).resolves.toEqual({
      gridCompany: { kind: 'none' },
      priceArea: { kind: 'none' },
      powerhour: { kind: 'has_price_device' },
    });
    expect(readHubLocation).not.toHaveBeenCalled();
  });

  it('on Homey Energy in Norway with no Norway settings, still sends the location nowhere', async () => {
    // A Norwegian hub with the Norway settings missing is the one the Norway
    // lookup would serve: only the source in force keeps it from running.
    mockHomeyInstance.settings.set('price_scheme', 'homey');
    const { coordinator, readHubLocation } = createCoordinator('NO');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(coordinator.suggestPriceSetup()).resolves.toMatchObject({ gridCompany: { kind: 'none' } });
    expect(readHubLocation).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('on Homey Energy, suggests nothing when Power by the Hour is not installed', async () => {
    mockHomeyInstance.settings.set('price_scheme', 'homey');
    setMockApiApp(POWERHOUR_APP_ID, { installed: false, get: powerhourGet });
    const { coordinator } = createCoordinator();

    await expect(coordinator.suggestPriceSetup()).resolves.toMatchObject({ powerhour: { kind: 'none' } });
  });

  it('on Norway, never asks Power by the Hour', async () => {
    mockHomeyInstance.settings.set('price_scheme', 'norway');
    const { coordinator } = createCoordinator();

    await expect(coordinator.suggestPriceSetup()).resolves.toMatchObject({ powerhour: { kind: 'none' } });
    expect(powerhourGet).not.toHaveBeenCalled();
  });
});
