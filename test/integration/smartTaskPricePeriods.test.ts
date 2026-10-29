import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import {
  EXPORT_FIXED, EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR, FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';
import { noHomeyEnergyPrices, noHomeyWebApi } from '../helpers/homeyWebApiStub';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

const START_MS = Date.parse('2026-10-25T10:00:00Z');
const QUARTER_MS = 15 * 60_000;
let priceCache = createInMemoryPriceCache();

const createService = (timeZone = 'Europe/Stockholm'): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  { structuredLog: testLogger },
  () => timeZone,
  noHomeyEnergyPrices,
  createPriceDataStore(mockHomeyInstance.settings, priceCache),
  () => ({}),
  noHomeyWebApi,
);

describe('Smart-task prices from the native source', () => {
  beforeEach(() => {
    resetMockHomey();
    priceCache = createInMemoryPriceCache();
    vi.useFakeTimers().setSystemTime(START_MS);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    priceCache.write(FLOW_PRICES_TODAY, {
      dateKey: '2026-10-25',
      pricesByHour: { 11: 5 },
      pricesByPeriod: [10, -2, 8, 4].map((totalPrice, index) => ({
        startsAt: new Date(START_MS + index * QUARTER_MS).toISOString(),
        durationMinutes: 15,
        totalPrice,
      })),
      updatedAt: new Date(START_MS).toISOString(),
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('keeps quarters for tasks while budgets and lowest-price Flows still receive one weighted hour', () => {
    const service = createService();
    const horizon = service.buildPriceHorizon(START_MS, START_MS + 4 * QUARTER_MS);
    expect(horizon.map((entry) => entry.price)).toEqual([10, -2, 8, 4]);
    expect(horizon.every((entry) => entry.endMs - entry.startMs === QUARTER_MS)).toBe(true);
    expect(service.getCombinedHourlyPrices()).toEqual([
      { startsAt: new Date(START_MS).toISOString(), totalPrice: 5 },
    ]);
    expect(service.getTaskPricePeriodsForUi()[1]).toEqual({
      startsAtMs: START_MS + QUARTER_MS,
      endsAtMs: START_MS + 2 * QUARTER_MS,
      price: -2,
      planningPrice: -2,
      isCheap: true,
      isExpensive: false,
    });
  });

  it('prorates solar coverage consistently and keeps the import price for metered money', () => {
    mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
    mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 0);
    mockHomeyInstance.settings.set(EXPORT_FIXED, -1);
    const service = createService();
    service.setBudgetPriceInputs({
      getSurplusKwh: () => 2,
      getPowerLimitSettings: () => capacityOnlyPowerLimits(4),
    });
    const horizon = service.buildPriceHorizon(START_MS, START_MS + 4 * QUARTER_MS);
    expect(horizon.map((entry) => entry.price)).toEqual([4.5, -1.5, 3.5, 1.5]);
    expect(horizon.map((entry) => entry.moneyPrice)).toEqual([10, -2, 8, 4]);
    const metered = service.getMeteredPricePeriods(START_MS + QUARTER_MS, START_MS + 3 * QUARTER_MS);
    expect(metered.map((entry) => entry.priceValue)).toEqual([-2, 8]);
    expect(metered.map((entry) => entry.tone)).toEqual(['cheap', 'expensive']);
    expect(metered.every((entry) => entry.costDisplay.divisor === 1)).toBe(true);
  });

  // A delivery tick after local midnight books the seconds before it too. The
  // day rollover has dropped yesterday's payload by then, so the price owner
  // keeps the periods it served until they have left the metering window.
  it('prices a delivery slice that straddles local midnight', () => {
    const midnightMs = Date.parse('2026-10-28T23:00:00Z'); // 00:00 in Oslo
    const quarters = (dayStartMs: number, prices: number[]) => prices.map((totalPrice, index) => ({
      startsAt: new Date(dayStartMs + index * QUARTER_MS).toISOString(),
      durationMinutes: 15,
      totalPrice,
    }));
    priceCache.write(FLOW_PRICES_TODAY, {
      dateKey: '2026-10-28',
      pricesByHour: { 23: 6 },
      pricesByPeriod: quarters(midnightMs - 4 * QUARTER_MS, [3, 5, 7, 9]),
      updatedAt: new Date(midnightMs - 4 * QUARTER_MS).toISOString(),
    });
    priceCache.write(FLOW_PRICES_TOMORROW, {
      dateKey: '2026-10-29',
      pricesByHour: { 0: 2 },
      pricesByPeriod: quarters(midnightMs, [1, 2, 3, 2]),
      updatedAt: new Date(midnightMs - 4 * QUARTER_MS).toISOString(),
    });
    const service = createService('Europe/Oslo');
    vi.setSystemTime(midnightMs - 30_000);
    expect(service.getMeteredPricePeriods(midnightMs - 60_000, midnightMs - 30_000)
      .map((entry) => entry.priceValue)).toEqual([9]);

    vi.setSystemTime(midnightMs + 15_000);
    const metered = service.getMeteredPricePeriods(midnightMs - 15_000, midnightMs + 15_000);
    expect(metered.map((entry) => [entry.startMs, entry.endMs, entry.priceValue])).toEqual([
      [midnightMs - QUARTER_MS, midnightMs, 9],
      [midnightMs, midnightMs + QUARTER_MS, 1],
    ]);
  });
});
