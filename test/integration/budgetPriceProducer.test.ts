// Integration proof that the planning price (budgetPrice) is layered onto the real
// producer (`PriceService.getCombinedHourlyPrices()`) from the injected forecast
// surplus, on top of the already-resolved export price — and is inert (≡ total)
// until that surplus is injected, so non-prosumer behaviour is unchanged.
//
// PriceService is constructed directly with only its outward energy seam mocked, so
// this is integration-tier — the sibling of exportPriceMarkets.test.ts.
import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../setup/priceDataAdapter';
import { mockHomeyInstance } from '../mocks/homey';
import { VAT_MULTIPLIER_STANDARD } from '../../lib/price/priceComponents';
import { EXPORT_FIXED, EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR, PRICE_SCHEME } from '../../lib/utils/settingsKeys';

const TZ = 'Europe/Oslo';

const createService = (): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  { log: () => {}, debugStructured: () => {} },
  () => TZ,
  undefined,
  createPriceDataStore(mockHomeyInstance as never),
);

describe('budgetPrice layered onto the producer from injected forecast surplus', () => {
  const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
  const hourA = new Date(Date.UTC(2026, 0, 15, 10, 0, 0)).toISOString();
  const hourB = new Date(Date.UTC(2026, 0, 15, 11, 0, 0)).toISOString();

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
    vi.useFakeTimers().setSystemTime(now);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
    mockHomeyInstance.settings.set('price_area', 'NO1');
    mockHomeyInstance.settings.set('nettleie_fylke', '03');
    mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');
    mockHomeyInstance.settings.set('provider_surcharge', 0);
    mockHomeyInstance.settings.set('nettleie_data', []);
    mockHomeyInstance.settings.set('electricity_prices', [
      { startsAt: hourA, spotPriceExVat: 100, currency: 'NOK' },
      { startsAt: hourB, spotPriceExVat: 100, currency: 'NOK' },
    ]);
    mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
    mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, 90);
    mockHomeyInstance.settings.set(EXPORT_FIXED, 0);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('blends export+import on the surplus hour, leaving the rest at total', () => {
    const service = createService();
    service.setBudgetPriceInputs({
      getSurplusKwh: (ms) => (ms === Date.parse(hourA) ? 2 : 0),
      expectedManagedDrawKwh: 4, // coverage on hourA = 2/4 = 0.5
    });

    const byHour = new Map(service.getCombinedHourlyPrices().map((p) => [p.startsAt, p]));
    const a = byHour.get(hourA);
    const b = byHour.get(hourB);
    const exportA = 100 * VAT_MULTIPLIER_STANDARD * 0.9;
    expect(a?.budgetPrice).toBeCloseTo(0.5 * exportA + 0.5 * (a?.totalPrice ?? 0), 6);
    expect(b?.budgetPrice).toBeUndefined(); // no surplus ⇒ falls back to total
  });

  it('is inert (no budgetPrice) until inputs are injected — non-prosumer parity', () => {
    const prices = createService().getCombinedHourlyPrices();
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((p) => p.budgetPrice === undefined)).toBe(true);
  });
});
