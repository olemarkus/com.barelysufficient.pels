// Integration proof that export (feed-in) pricing is applied INDEPENDENTLY of the
// import scheme — the "kept entirely separate" invariant. Export config is read
// once and decorates whatever import series the active scheme produced; no import
// builder owns it. Two market use cases drive the real producer
// (`PriceService.getCombinedHourlyPrices()`, the single chokepoint that feeds the
// persisted `combined_prices` seam and every price consumer), seeding raw prices
// through the SDK settings/energy seam and asserting the resolved `exportPrice`:
//
//   • Norwegian plusskunde — the `norway` import scheme isolates a wholesale spot,
//     so a spot-linked export config (×factor) tracks it, negative spot included.
//   • Netherlands — the `homey`/`flow` schemes carry no isolatable spot, so a
//     fixed feed-in tariff applies flat to every hour (even a negative-import
//     midday-solar hour), and a spot-linked config produces NO export price
//     because there is nothing to link to.
//
// PriceService is constructed directly with only its outward energy seam mocked,
// so this is integration-tier (one layer), the sibling of homeyPriceService.test.ts
// and norgesprisPriceService.test.ts.
import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PriceService from '../../lib/price/priceService';
import { createPriceDataStore } from '../../setup/priceDataAdapter';
import { mockHomeyInstance } from '../mocks/homey';
import { VAT_MULTIPLIER_STANDARD } from '../../lib/price/priceComponents';
import { getDateKeyInTimeZone, getDateKeyStartMs } from '../../lib/utils/dateUtils';
import {
  EXPORT_FIXED,
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';
import type { HomeyEnergyApi, HomeyEnergyPriceInterval } from '../../lib/utils/homeyEnergy';

const TZ = 'Europe/Oslo';

const createService = (energyApi?: HomeyEnergyApi): PriceService => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  { log: () => {}, debugStructured: () => {} },
  () => TZ,
  energyApi ? () => energyApi : undefined,
  createPriceDataStore(mockHomeyInstance as never),
);

// Export config is separate from import config: its own keys, read at price-build
// time. Set AFTER seeding import prices to prove the producer reads it live.
const enableExport = (params: { spotFactorPercent: number; fixedInclVat: number }): void => {
  mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
  mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, params.spotFactorPercent);
  mockHomeyInstance.settings.set(EXPORT_FIXED, params.fixedInclVat);
};

describe('Export (feed-in) pricing applied independently of the import scheme', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Norwegian plusskunde — spot-linked export on the norway import scheme', () => {
    const now = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    const hourA = new Date(Date.UTC(2026, 0, 15, 10, 0, 0)).toISOString();
    const hourB = new Date(Date.UTC(2026, 0, 15, 11, 0, 0)).toISOString();

    const seedNorway = (spotPrices: Array<{ startsAt: string; spotPriceExVat: number; currency: string }>): void => {
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
      mockHomeyInstance.settings.set('price_area', 'NO1');
      mockHomeyInstance.settings.set('nettleie_fylke', '03');
      mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');
      mockHomeyInstance.settings.set('provider_surcharge', 0);
      mockHomeyInstance.settings.set('electricity_prices', spotPrices);
      mockHomeyInstance.settings.set('nettleie_data', []);
    };

    it('links export to the wholesale spot (×factor), tracking it negative under negative spot', () => {
      vi.useFakeTimers().setSystemTime(now);
      seedNorway([
        { startsAt: hourA, spotPriceExVat: 100, currency: 'NOK' },
        { startsAt: hourB, spotPriceExVat: -40, currency: 'NOK' }, // negative-spot hour
      ]);
      enableExport({ spotFactorPercent: 90, fixedInclVat: 0 }); // ~plusskunde

      const byHour = new Map(createService().getCombinedHourlyPrices().map((p) => [p.startsAt, p]));
      // export = VAT-grossed spot × factor; carries none of the import cost stack.
      expect(byHour.get(hourA)?.exportPrice).toBeCloseTo(100 * VAT_MULTIPLIER_STANDARD * 0.9, 6);
      // Negative spot ⇒ negative export, left unclamped.
      expect(byHour.get(hourB)?.exportPrice).toBeCloseTo(-40 * VAT_MULTIPLIER_STANDARD * 0.9, 6);
    });

    it('adds the fixed feed-in component on top of the spot term', () => {
      vi.useFakeTimers().setSystemTime(now);
      seedNorway([{ startsAt: hourA, spotPriceExVat: 100, currency: 'NOK' }]);
      enableExport({ spotFactorPercent: 90, fixedInclVat: 5 });

      const [entry] = createService().getCombinedHourlyPrices();
      expect(entry?.exportPrice).toBeCloseTo(100 * VAT_MULTIPLIER_STANDARD * 0.9 + 5, 6);
    });

    it('attaches no export price when export is disabled (import series unchanged)', () => {
      vi.useFakeTimers().setSystemTime(now);
      seedNorway([{ startsAt: hourA, spotPriceExVat: 100, currency: 'NOK' }]);
      // export config left untouched (disabled)

      const prices = createService().getCombinedHourlyPrices();
      expect(prices.length).toBeGreaterThan(0);
      expect(prices.every((p) => p.exportPrice === undefined)).toBe(true);
    });
  });

  describe('Netherlands — fixed feed-in tariff on a scheme with no isolatable spot (homey)', () => {
    const fixedNow = new Date(Date.UTC(2026, 0, 19, 12, 0, 0));

    const buildIntervals = (startUtcMs: number, values: number[]): HomeyEnergyPriceInterval[] => (
      values.map((value, index) => ({
        periodStart: new Date(startUtcMs + index * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(startUtcMs + (index + 1) * 60 * 60 * 1000).toISOString(),
        value,
      }))
    );

    // Seed Homey Energy dynamic prices through the energy-API seam (as production
    // does), then build. `todayValues` includes a negative midday hour (heavy NL
    // solar) to prove the import sign never leaks into the fixed export tariff.
    const seedHomeyAndRefresh = async (todayValues: number[]): Promise<PriceService> => {
      const todayKey = getDateKeyInTimeZone(fixedNow, TZ);
      const todayStartMs = getDateKeyStartMs(todayKey, TZ);
      const todayIntervals = buildIntervals(todayStartMs, todayValues);
      const energyApi: HomeyEnergyApi = {
        fetchDynamicElectricityPrices: vi.fn().mockImplementation(async ({ date }: { date: string }) => (
          date === todayKey
            ? { interval: 60, pricesPerInterval: todayIntervals, priceUnit: 'EUR' }
            : { interval: 60, pricesPerInterval: [], priceUnit: 'EUR' }
        )),
        getCurrency: vi.fn().mockResolvedValue({ currency: 'EUR' }),
      };
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
      const service = createService(energyApi);
      await service.refreshSpotPrices(true);
      return service;
    };

    it('applies the flat feed-in tariff to every hour, independent of the (even negative) import price', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      const service = await seedHomeyAndRefresh([0.30, -0.05, 0.20]); // negative midday import
      enableExport({ spotFactorPercent: 0, fixedInclVat: 0.08 }); // fixed 0.08/kWh feed-in

      const prices = service.getCombinedHourlyPrices();
      expect(prices.length).toBeGreaterThan(0);
      expect(prices.every((p) => p.exportPrice === 0.08)).toBe(true);
      // The negative import hour kept its negative total — export did not bleed in.
      expect(prices.some((p) => p.totalPrice < 0)).toBe(true);
    });

    it('produces no export price for a spot-linked config — there is no isolatable spot to link to', async () => {
      vi.useFakeTimers().setSystemTime(fixedNow);
      const service = await seedHomeyAndRefresh([0.30, 0.20]);
      enableExport({ spotFactorPercent: 90, fixedInclVat: 0.08 }); // spot-linked, but no spot here

      const prices = service.getCombinedHourlyPrices();
      expect(prices.length).toBeGreaterThan(0);
      expect(prices.every((p) => p.exportPrice === undefined)).toBe(true);
    });
  });
});
