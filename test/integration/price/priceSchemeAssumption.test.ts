import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockApiApp } from '../../mocks/homey';
import { PriceCoordinator } from '../../../lib/price/priceCoordinator';
import { createPriceOptimizationSettingsStore } from '../../../lib/price/priceOptimizationSettingsStore';
import { createPriceDataStore } from '../../../lib/price/priceDataStore';
import { POWERHOUR_APP_ID } from '../../../lib/price/powerhourPriceFetch';
import {
  EXPORT_FIXED, EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR, PRICE_OPTIMIZATION_SETTINGS, PRICE_SCHEME,
} from '../../../lib/utils/settingsKeys';
import type { SettingsUiHubMarketRead } from '../../../packages/contracts/src/settingsUi/webApp';
import { createInMemoryPriceCache } from '../../helpers/priceCacheForTests';
import { homeyWebApiServing, hubMarketIn } from '../../helpers/homeyWebApiStub';

const DYNAMIC_PRICES_PREFIX = 'manager/energy/price/electricity/dynamic?date=';

const createCoordinator = (readHubMarket: () => Promise<SettingsUiHubMarketRead>) => {
  const webApi = homeyWebApiServing({});
  const info = vi.fn();
  const coordinator = new PriceCoordinator({
    homey: mockHomeyInstance as never,
    priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(mockHomeyInstance.settings),
    priceDataStore: createPriceDataStore(mockHomeyInstance.settings, createInMemoryPriceCache()),
    getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
    getPowerTracker: () => ({}),
    homeyWebApiGet: webApi.get,
    readHubMarket,
    readHubLocation: async () => ({ kind: 'unavailable' as const }),
    error: () => undefined,
    structuredLog: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  });
  return { coordinator, requestedPaths: webApi.requestedPaths, info };
};

describe('price source assumed from the hub country', () => {
  beforeEach(() => {
    resetMockHomey();
    // An installed app always has settings keys; only the price source is unsaved.
    mockHomeyInstance.settings.set('capacity_limit_kw', 8);
  });

  it('prices a hub outside Norway from Homey Energy when the owner never chose a source', async () => {
    const { coordinator, requestedPaths, info } = createCoordinator(hubMarketIn('NL'));

    await coordinator.refreshSpotPrices();

    expect(requestedPaths.some((path) => path.startsWith(DYNAMIC_PRICES_PREFIX))).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'price_source_switched', scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' },
    }));
    const read = coordinator.readPriceSetup();
    expect(read.state === 'resolved' && read.setup.source)
      .toEqual({ scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' } });
  });

  it('turns off an export price entered in øre when it moves the home to Homey Energy', async () => {
    // Entered while the home ran on the Norway source, so -5 means øre/kWh.
    // Read in Homey Energy's currency it would be a hundred times too large.
    mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
    mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 90);
    mockHomeyInstance.settings.set(EXPORT_FIXED, -5);
    const { coordinator, info } = createCoordinator(hubMarketIn('NL'));

    await coordinator.refreshSpotPrices();

    expect(mockHomeyInstance.settings.get(EXPORT_PRICE_ENABLED)).toBe(false);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'export_price_settled_for_source_change', plan: 'disable_export',
    }));
  });

  describe('with Power by the Hour pricing the home', () => {
    const NL_DEVICE = {
      deviceId: '10YNL----------L_abc',
      deviceName: 'NL',
      driverType: 'dap',
      biddingZone: '10YNL----------L',
      currency: '€',
      priceInterval: 60,
      slots: [{ time: '2026-10-13T10:00:00.000Z', importPrice: 0.21, exportPrice: 0, isForecast: false }],
    };

    beforeEach(() => {
      setMockApiApp(POWERHOUR_APP_ID, { installed: true, get: async () => ({ prices: [NL_DEVICE] }) });
    });

    it('prices from Power by the Hour while nothing follows prices yet', async () => {
      const { coordinator, info } = createCoordinator(hubMarketIn('NL'));

      await coordinator.refreshSpotPrices();

      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'price_source_switched', scheme: 'powerhour', basis: { kind: 'hub_location', country: 'NL' },
      }));
    });

    it('lets a later refresh decide when an earlier one\'s reads were overtaken', async () => {
      // The earlier refresh found Power by the Hour not running, then waited on
      // the hub's country while a later refresh found it priced the home.
      let answerFirst: (market: SettingsUiHubMarketRead) => void = () => undefined;
      const markets = [
        new Promise<SettingsUiHubMarketRead>((resolve) => { answerFirst = resolve; }),
        Promise.resolve<SettingsUiHubMarketRead>({ state: 'resolved', country: 'NL' }),
      ];
      const { coordinator } = createCoordinator(async () => markets.shift() ?? hubMarketIn('NL')());
      setMockApiApp(POWERHOUR_APP_ID, { installed: false, get: async () => ({ prices: [] }) });
      const earlier = coordinator.refreshSpotPrices();
      setMockApiApp(POWERHOUR_APP_ID, { installed: true, get: async () => ({ prices: [NL_DEVICE] }) });
      await coordinator.refreshSpotPrices();

      answerFirst({ state: 'resolved', country: 'NL' });
      await earlier;

      const read = coordinator.readPriceSetup();
      expect(read.state === 'resolved' && read.setup.source.scheme).toBe('powerhour');
    });

    it('leaves the move to the owner once a device follows prices', async () => {
      mockHomeyInstance.settings.set(PRICE_OPTIMIZATION_SETTINGS, {
        heater: { enabled: true, cheapDelta: 1, expensiveDelta: -1 },
      });
      const { coordinator } = createCoordinator(hubMarketIn('NL'));

      await coordinator.refreshSpotPrices();

      const read = coordinator.readPriceSetup();
      expect(read.state === 'resolved' && read.setup.source)
        .toEqual({ scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' } });
    });
  });

  it('leaves a saved source alone in any country', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    const { coordinator, requestedPaths, info } = createCoordinator(hubMarketIn('NL'));

    await coordinator.refreshSpotPrices();

    expect(requestedPaths.some((path) => path.startsWith(DYNAMIC_PRICES_PREFIX))).toBe(false);
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'price_source_switched' }));
    const read = coordinator.readPriceSetup();
    expect(read.state === 'resolved' && read.setup.source).toEqual({ scheme: 'flow', basis: { kind: 'chosen' } });
  });
});
