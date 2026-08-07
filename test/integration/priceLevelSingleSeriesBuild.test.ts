import type Homey from 'homey';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../setup/priceDataAdapter';
import { mockHomeyInstance } from '../mocks/homey';
import { PRICE_SCHEME } from '../../lib/utils/settingsKeys';
import { getDateKeyInTimeZone, getZonedParts } from '../../lib/utils/dateUtils';

/**
 * `getCombinedHourlyPrices()` has no cache: every call re-reads ~12 settings,
 * runs one `Intl.DateTimeFormat.formatToParts` per spot hour, and walks the
 * whole grid-tariff table — ~25 ms on a Homey Pro. Asking `isCurrentHourCheap()`
 * and `isCurrentHourExpensive()` back to back therefore rebuilt the entire
 * series twice to answer one question, on both hot paths (the plan builder's
 * per-cycle price level and the status writer's compute).
 *
 * `getCurrentHourPriceLevel()` answers both from a single build. This suite pins
 * the build count, because nothing else would notice it regressing — the flags
 * are identical either way.
 */
const TZ = 'Europe/Oslo';
const NOW = new Date('2026-03-11T10:30:00.000Z');

const createService = (): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  { log: () => {}, debugStructured: () => {} },
  () => TZ,
  undefined,
  createPriceDataStore(mockHomeyInstance as never),
);

/**
 * A 24-hour series whose current hour sits far below the average, so the hour
 * classifies cheap and the two flags differ — a run that silently answered
 * `{cheap: false, expensive: false}` would not pass.
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
  mockHomeyInstance.settings.set('nettleie_data', [{
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
    seedCheapCurrentHour();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds the combined series once for both flags', () => {
    const service = createService();
    const buildSpy = vi.spyOn(service, 'getCombinedHourlyPrices');

    const level = service.getCurrentHourPriceLevel();

    expect(level).toEqual({ cheap: true, expensive: false });
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('agrees with the two single-flag predicates it replaces', () => {
    const service = createService();

    // The predicates are the pre-existing behaviour; the combined resolver must
    // not change any answer, only the number of builds it takes to get there.
    expect(service.getCurrentHourPriceLevel()).toEqual({
      cheap: service.isCurrentHourCheap(),
      expensive: service.isCurrentHourExpensive(),
    });
  });

  it('costs two builds when the single-flag predicates are used back to back', () => {
    const service = createService();
    const buildSpy = vi.spyOn(service, 'getCombinedHourlyPrices');

    // Pins the cost this change removes: without the combined resolver, the two
    // hot callers paid this. If a future refactor makes the predicates share a
    // build, this expectation is the thing to update — not to delete.
    service.isCurrentHourCheap();
    service.isCurrentHourExpensive();

    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('reports neither flag when the current hour has no price', () => {
    mockHomeyInstance.settings.set('electricity_prices', []);
    const service = createService();

    expect(service.getCurrentHourPriceLevel()).toEqual({ cheap: false, expensive: false });
  });
});
