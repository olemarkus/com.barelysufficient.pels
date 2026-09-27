import type Homey from 'homey';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';
import { mockHomeyInstance } from '../mocks/homey';
import { PRICE_SCHEME } from '../../lib/utils/settingsKeys';
import {
  getDateKeyInTimeZone,
  getZonedParts,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { PriceLevel } from '../../lib/price/priceLevels';
import { noHomeyEnergyPrices, noHomeyWebApi } from '../helpers/homeyWebApiStub';

/**
 * `getCombinedPricePeriods()` has no cache: every call re-reads ~12 settings,
 * runs one `Intl.DateTimeFormat.formatToParts` per spot period, and walks the
 * whole grid-tariff table — ~25 ms on a Homey Pro. Asking for the cheap and the
 * expensive flag separately rebuilt the entire series twice to answer one
 * question, on both hot paths (the plan builder's per-cycle price level and the
 * status writer's compute).
 *
 * `getCurrentHourPriceLevel()` answers the resolved level from a single build.
 * This suite pins the build count, because nothing else would notice it
 * regressing — the level is identical either way.
 */
const TZ = 'Europe/Oslo';
const NOW = new Date('2026-03-11T10:30:00.000Z');

let priceCache = createInMemoryPriceCache();

const createService = (): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  { log: () => {}, debugStructured: () => {} },
  () => TZ,
  noHomeyEnergyPrices,
  createPriceDataStore(mockHomeyInstance.settings, priceCache),
  () => ({}),
  noHomeyWebApi,
);

/**
 * A 24-hour series whose current hour sits far below the average, so the hour
 * classifies cheap and the two flags differ — a run that silently answered
 * `PriceLevel.UNKNOWN` would not pass.
 */
const seedCheapCurrentHour = (): void => {
  const dayStart = Date.UTC(2026, 2, 11, 0, 0, 0);
  const currentHourIso = new Date(Date.UTC(2026, 2, 11, 10, 0, 0)).toISOString();
  const spotPrices = Array.from({ length: 24 }, (_, i) => ({
    startsAt: new Date(dayStart + i * 3600_000).toISOString(),
    spotPriceExVat: new Date(dayStart + i * 3600_000).toISOString() === currentHourIso ? 10 : 300,
    currency: 'NOK',
  }));
  mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
  mockHomeyInstance.settings.set('norway_price_model', 'stromstotte');
  mockHomeyInstance.settings.set('price_area', 'NO1');
  mockHomeyInstance.settings.set('nettleie_fylke', '03');
  mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');
  mockHomeyInstance.settings.set('provider_surcharge', 0);
  mockHomeyInstance.settings.set('price_threshold_percent', 25);
  mockHomeyInstance.settings.set('price_min_diff_ore', 0);
  mockHomeyInstance.settings.set('electricity_prices', spotPrices);
  priceCache.write('grid_tariff', [{
    dateKey: getDateKeyInTimeZone(NOW, TZ),
    time: getZonedParts(NOW, TZ).hour,
    energyFeeExVat: 28,
  }]);
};

describe('current-hour price level resolves from a single series build', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockHomeyInstance.settings.clear?.();
    priceCache = createInMemoryPriceCache();
    seedCheapCurrentHour();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds the combined series once for both flags', () => {
    const service = createService();
    const buildSpy = vi.spyOn(service, 'getCombinedPricePeriods');

    const level = service.getCurrentHourPriceLevel();

    expect(level).toEqual(PriceLevel.CHEAP);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('answers UNKNOWN when the current hour has no price', () => {
    mockHomeyInstance.settings.set('electricity_prices', []);
    const service = createService();

    expect(service.getCurrentHourPriceLevel()).toEqual(PriceLevel.UNKNOWN);
  });
});
