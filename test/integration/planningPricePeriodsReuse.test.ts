import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import type { PowerTrackerReadout } from '../../lib/price/priceServiceNorgespris';
import {
  EXPORT_FIXED, EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR, FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW,
  NORWAY_PRICE_MODEL, PRICE_SCHEME, PRICE_THRESHOLD_PERCENT,
} from '../../lib/utils/settingsKeys';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';
import { noHomeyEnergyPrices, noHomeyWebApi } from '../helpers/homeyWebApiStub';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

/**
 * Smart tasks cut a price horizon per task from the planning price periods on
 * every plan rebuild. The series is built once and reused until something it
 * was built from changes; a held series that outlives one of its inputs would
 * plan on prices that no longer apply. Each case below changes one input and
 * expects fresh prices.
 */
const TZ = 'Europe/Oslo';
const HOUR_MS = 60 * 60_000;
// 12:00 local on a winter day, so the local date and the UTC date agree.
const NOW_MS = Date.parse('2026-01-14T11:00:00.000Z');
const DAY_START_MS = Date.parse('2026-01-13T23:00:00.000Z');
const TODAY = '2026-01-14';
const TOMORROW = '2026-01-15';

let priceCache = createInMemoryPriceCache();
let powerTracker: PowerTrackerReadout = {};

const createService = (): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  { structuredLog: testLogger },
  () => TZ,
  noHomeyEnergyPrices,
  createPriceDataStore(mockHomeyInstance.settings, priceCache),
  () => powerTracker,
  noHomeyWebApi,
);

const flowDay = (dateKey: string, price: number): unknown => ({
  dateKey,
  pricesByHour: Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour, price + hour])),
  updatedAt: new Date(NOW_MS).toISOString(),
});

const seedSpotPrices = (): void => {
  priceCache.write('spot_prices', Array.from({ length: 24 }, (_, hour) => ({
    startsAt: new Date(DAY_START_MS + hour * HOUR_MS).toISOString(),
    spotPriceExVat: 100 + hour,
    currency: 'NOK',
  })));
};

/** Builds of the series, counted where the stored prices are turned into periods. */
const countBuilds = (service: PriceService): { count: () => number } => {
  const spy = vi.spyOn(service as unknown as { buildImportPricePeriods: () => unknown }, 'buildImportPricePeriods');
  return { count: () => spy.mock.calls.length };
};

const horizonPrices = (service: PriceService): number[] => (
  service.buildPriceHorizon(NOW_MS, NOW_MS + 3 * HOUR_MS).map((entry) => entry.price)
);

describe('planning price periods are reused until an input changes', () => {
  beforeEach(() => {
    resetMockHomey();
    priceCache = createInMemoryPriceCache();
    powerTracker = {};
    vi.useFakeTimers().setSystemTime(NOW_MS);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    priceCache.write(FLOW_PRICES_TODAY, flowDay(TODAY, 10));
    priceCache.write(FLOW_PRICES_TOMORROW, flowDay(TOMORROW, 50));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds the series once for every horizon, task price and metered price read', () => {
    const service = createService();
    const builds = countBuilds(service);

    const first = horizonPrices(service);
    for (let task = 0; task < 9; task += 1) {
      expect(service.buildPriceHorizon(NOW_MS, NOW_MS + (task + 1) * HOUR_MS)).toHaveLength(task + 1);
    }
    expect(service.getTaskPricePeriodsForUi()).toHaveLength(48);
    expect(service.getMeteredPricePeriods(NOW_MS, NOW_MS + HOUR_MS)).toHaveLength(1);

    expect(first).toEqual([22, 23, 24]);
    expect(builds.count()).toBe(1);
  });

  it('serves new stored prices', () => {
    const service = createService();
    const builds = countBuilds(service);
    expect(horizonPrices(service)).toEqual([22, 23, 24]);

    service.storeFlowPriceData('today', JSON.stringify(
      Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour, 200 + hour])),
    ));

    expect(horizonPrices(service)).toEqual([212, 213, 214]);
    expect(horizonPrices(service)).toEqual([212, 213, 214]);
    // One for `storeFlowPriceData`'s own combined-price rebuild, one for the horizon.
    expect(builds.count()).toBeLessThanOrEqual(3);
  });

  it('serves the new source after a scheme change', () => {
    const service = createService();
    expect(horizonPrices(service)).toEqual([22, 23, 24]);

    seedSpotPrices();
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');

    const norway = horizonPrices(service);
    expect(norway).toHaveLength(3);
    expect(norway).not.toEqual([22, 23, 24]);
  });

  it('serves the new day after the local date rolls over', () => {
    const service = createService();
    expect(horizonPrices(service)).toEqual([22, 23, 24]);

    vi.setSystemTime(NOW_MS + 24 * HOUR_MS);

    const tomorrowNoon = service.buildPriceHorizon(NOW_MS + 24 * HOUR_MS, NOW_MS + 27 * HOUR_MS);
    expect(tomorrowNoon.map((entry) => entry.price)).toEqual([62, 63, 64]);
    // Yesterday's periods are gone with their day.
    expect(horizonPrices(service)).toEqual([]);
  });

  it('classifies task prices against a changed price level band without a rebuild', () => {
    const service = createService();
    const builds = countBuilds(service);
    mockHomeyInstance.settings.set(PRICE_THRESHOLD_PERCENT, 25);
    const cheapBefore = service.getTaskPricePeriodsForUi().filter((period) => period.isCheap).length;

    mockHomeyInstance.settings.set(PRICE_THRESHOLD_PERCENT, 90);

    const cheapAfter = service.getTaskPricePeriodsForUi().filter((period) => period.isCheap).length;
    expect(cheapBefore).toBeGreaterThan(cheapAfter);
    expect(builds.count()).toBe(1);
  });

  describe('with the Norway source', () => {
    beforeEach(() => {
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
      mockHomeyInstance.settings.set('price_area', 'NO1');
      seedSpotPrices();
    });

    it('serves a changed export price setting', () => {
      const service = createService();
      service.setBudgetPriceInputs({
        getPowerLimitSettings: () => capacityOnlyPowerLimits(4),
        getSurplusKwh: () => 4,
      });
      mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 0);
      mockHomeyInstance.settings.set(EXPORT_FIXED, 5);
      const importPrices = horizonPrices(service);

      mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
      // Surplus covers the whole flexible appetite, so the planning price is the export price.
      expect(horizonPrices(service)).toEqual([5, 5, 5]);

      mockHomeyInstance.settings.set(EXPORT_FIXED, 7);
      expect(horizonPrices(service)).toEqual([7, 7, 7]);

      mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, false);
      expect(horizonPrices(service)).toEqual(importPrices);
    });

    it('serves a changed solar surplus forecast and a changed flexible appetite', () => {
      const service = createService();
      const builds = countBuilds(service);
      let surplusKwh = 0;
      let limitKw = 4;
      service.setBudgetPriceInputs({
        getPowerLimitSettings: () => capacityOnlyPowerLimits(limitKw),
        getSurplusKwh: () => surplusKwh,
      });
      mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
      mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 0);
      mockHomeyInstance.settings.set(EXPORT_FIXED, 5);
      const importPrices = horizonPrices(service);
      expect(horizonPrices(service)).toEqual(importPrices);
      expect(builds.count()).toBe(1);

      surplusKwh = 4;
      expect(horizonPrices(service)).toEqual([5, 5, 5]);

      limitKw = 8;
      const halfCovered = horizonPrices(service);
      expect(halfCovered).toEqual(importPrices.map((price) => (price + 5) / 2));
      expect(horizonPrices(service)).toEqual(halfCovered);
      expect(builds.count()).toBe(3);
    });

    it('serves a Norway setting that has no settings handler', () => {
      const service = createService();
      const builds = countBuilds(service);
      const withVat = horizonPrices(service);

      // Finnmark pays no VAT on electricity.
      mockHomeyInstance.settings.set('price_area', 'NO4');
      priceCache.write('spot_price_area', 'NO4');
      mockHomeyInstance.settings.set('nettleie_fylke', '56');

      const withoutVat = horizonPrices(service);
      expect(withoutVat).toHaveLength(3);
      expect(withoutVat[0]).toBeLessThan(withVat[0]);
      expect(builds.count()).toBe(2);
    });

    it('follows the month usage and the passing hour on Norgespris', () => {
      mockHomeyInstance.settings.set(NORWAY_PRICE_MODEL, 'norgespris');
      const service = createService();
      const builds = countBuilds(service);
      const underCap = horizonPrices(service);
      expect(horizonPrices(service)).toEqual(underCap);
      expect(builds.count()).toBe(1);

      // The month's cap is used up: the hours ahead pay the spot price again.
      powerTracker = { dailyTotals: { '2026-01-05': 100_000 } };
      expect(horizonPrices(service)).not.toEqual(underCap);
      expect(builds.count()).toBe(2);

      vi.setSystemTime(NOW_MS + HOUR_MS);
      horizonPrices(service);
      expect(builds.count()).toBe(3);
    });
  });

  it('keeps reading the stores while the home has no prices', () => {
    priceCache.remove(FLOW_PRICES_TODAY);
    priceCache.remove(FLOW_PRICES_TOMORROW);
    const service = createService();
    const builds = countBuilds(service);

    expect(horizonPrices(service)).toEqual([]);
    expect(horizonPrices(service)).toEqual([]);

    expect(builds.count()).toBe(2);
  });
});
