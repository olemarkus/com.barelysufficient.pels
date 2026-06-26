// SDK-boundary e2e: export (feed-in) pricing applied INDEPENDENTLY of the import
// scheme, proven end-to-end through the full app. Nothing internal is mocked.
//
// Raw market prices enter through the REAL external seams — the Norwegian spot
// fetch over `https` (hvakosterstrommen) and the Homey Energy API
// (`homey.api.energy`) — drive the real PriceService producer + scheme dispatch +
// scheme-independent export decoration, and the only thing asserted is what PELS
// writes back through the SDK: the persisted `combined_prices` payload.
//
// Two market use cases, same export-config mechanism (`export_price_enabled` +
// `export_spot_factor` + `export_fixed`), different import scheme:
//   • Norwegian plusskunde (norway scheme) — wholesale spot is isolatable, so a
//     spot-linked config tracks it (negative spot included).
//   • Netherlands (homey scheme) — no isolatable spot, so a fixed feed-in tariff
//     applies flat to every hour (even a negative-import midday-solar hour), and a
//     spot-linked config yields NO export price (nothing to link to).
//
// Counterpart to test/integration/exportPriceMarkets.test.ts (the PriceService
// single-layer integration test).
import type { Mock } from 'vitest';
import https from 'https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { flattenAllHours } from '../../lib/price/priceStore';
import { getDateKeyInTimeZone, getDateKeyStartMs } from '../../lib/utils/dateUtils';
import {
  COMBINED_PRICES,
  EXPORT_FIXED,
  EXPORT_PRICE_ENABLED,
  EXPORT_SPOT_FACTOR,
  PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';
import type { CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { HomeyEnergyApi, HomeyEnergyPriceInterval } from '../../lib/utils/homeyEnergy';

vi.mock('https', () => ({ default: { get: vi.fn() } }));

const TZ = 'Europe/Oslo';

const createMockHttpsResponse = (statusCode: number, data: unknown) => {
  const response: { statusCode: number; statusMessage: string; on: Mock } = {
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : 'Error',
    on: vi.fn((event: string, callback: (chunk?: string) => void) => {
      if (event === 'data') callback(JSON.stringify(data));
      if (event === 'end') callback();
      return response;
    }),
  };
  return response;
};

const respondWith = (mock: Mock, data: unknown, statusCode = 200): void => {
  mock.mockImplementation((_url: string, _options: unknown, callback: (r: unknown) => void) => {
    callback(createMockHttpsResponse(statusCode, data));
    return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
  });
};

const enableExport = (params: { spotFactorPercent: number; fixedInclVat: number }): void => {
  mockHomeyInstance.settings.set(EXPORT_PRICE_ENABLED, true);
  mockHomeyInstance.settings.set(EXPORT_SPOT_FACTOR, params.spotFactorPercent);
  mockHomeyInstance.settings.set(EXPORT_FIXED, params.fixedInclVat);
};

// Install a typed Homey Energy API on the SDK mock so the app's
// `resolveHomeyEnergyApiFromSdk(homey.api.energy)` resolves the homey-scheme seam.
const setEnergyApi = (energy: HomeyEnergyApi): void => {
  Object.assign(mockHomeyInstance.api, { energy });
};

// Boot the app, drive a deterministic forced refresh through the real fetch seam,
// then persist the combined-prices payload from the stored raw prices.
const bootAndBuild = async (): Promise<CombinedPricesV2 | null> => {
  const app = createApp();
  await app.onInit();
  await app.priceCoordinator.refreshSpotPrices(true); // awaited fetch + store
  app.priceCoordinator.updateCombinedPrices(); // build + persist combined_prices
  return mockHomeyInstance.settings.get(COMBINED_PRICES) as CombinedPricesV2 | null;
};

describe('Export (feed-in) pricing per market (SDK-boundary e2e)', () => {
  let mockHttpsGet: Mock;

  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler reads
    // Date.now() (app.ts getAppPlanRebuildNowMs); a real-vs-fake split strands it.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    // A winter date so the spot fixture's +01:00 offset is the correct Oslo offset.
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    // Default Homey Energy seam (overridden in the NL cases); default https = no data.
    setEnergyApi({
      fetchDynamicElectricityPrices: async () => ({ interval: 60, pricesPerInterval: [], priceUnit: 'NOK' }),
      getCurrency: async () => ({ currency: 'NOK' }),
    });
    mockHttpsGet = https.get as unknown as Mock;
    mockHttpsGet.mockReset();
    respondWith(mockHttpsGet, null, 404);
    setMockDrivers({ d: new MockDriver('d', [new MockDevice('h', 'Heater', ['target_temperature', 'onoff'])]) });
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Norwegian plusskunde — spot-linked export on the norway import scheme', () => {
    const seedNorwaySpot = (): void => {
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
      mockHomeyInstance.settings.set('price_area', 'NO1'); // standard VAT (×1.25)
      mockHomeyInstance.settings.set('nettleie_fylke', '03');
      mockHomeyInstance.settings.set('nettleie_tariffgruppe', 'Husholdning');
      mockHomeyInstance.settings.set('provider_surcharge', 0);
      // Drive today's spot through the real https fetch. A positive, a NEGATIVE,
      // and another positive hour. spotPriceExVat = NOK_per_kWh × 100 (øre).
      const today = getDateKeyInTimeZone(new Date(), TZ); // '2026-01-15'
      const mmdd = today.slice(5);
      const spot = [
        { NOK_per_kWh: 1.0, EUR_per_kWh: 0.09, EXR: 11, time_start: `${today}T10:00:00+01:00`, time_end: `${today}T11:00:00+01:00` },
        { NOK_per_kWh: -0.4, EUR_per_kWh: -0.036, EXR: 11, time_start: `${today}T11:00:00+01:00`, time_end: `${today}T12:00:00+01:00` },
        { NOK_per_kWh: 0.5, EUR_per_kWh: 0.045, EXR: 11, time_start: `${today}T12:00:00+01:00`, time_end: `${today}T13:00:00+01:00` },
      ];
      mockHttpsGet.mockImplementation((url: string, _options: unknown, callback: (r: unknown) => void) => {
        const body = url.includes('hvakosterstrommen') && url.includes(mmdd) ? spot : null;
        callback(createMockHttpsResponse(body ? 200 : 404, body));
        return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
      });
    };

    it('persists a spot-linked export price (×factor) that tracks negative spot', async () => {
      seedNorwaySpot();
      enableExport({ spotFactorPercent: 90, fixedInclVat: 0 }); // ~plusskunde

      const hours = flattenAllHours(await bootAndBuild());
      const withSpot = hours.filter((h) => typeof h.spotPriceExVat === 'number');
      expect(withSpot.length).toBeGreaterThanOrEqual(2);
      for (const h of withSpot) {
        // export = VAT-grossed spot × factor; carries none of the import cost stack.
        expect(h.exportPrice).toBeCloseTo((h.spotPriceExVat ?? 0) * (h.vatMultiplier ?? 1) * 0.9, 4);
      }
      // The negative-spot hour produced a negative (unclamped) export price.
      expect(withSpot.some((h) => (h.exportPrice ?? 0) < 0)).toBe(true);
    });

    it('persists no export price when export is disabled', async () => {
      seedNorwaySpot();
      // export config left untouched (disabled)

      const hours = flattenAllHours(await bootAndBuild());
      expect(hours.length).toBeGreaterThan(0);
      expect(hours.every((h) => h.exportPrice === undefined)).toBe(true);
    });
  });

  describe('Netherlands — fixed feed-in tariff on a scheme with no isolatable spot (homey)', () => {
    // Drive Homey Energy dynamic prices through the real energy seam, including a
    // NEGATIVE midday hour (heavy NL solar), so we can prove the import sign never
    // leaks into the fixed export tariff.
    const seedHomeyEnergy = (todayValues: number[]): void => {
      mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
      const todayKey = getDateKeyInTimeZone(new Date(), TZ);
      const todayStartMs = getDateKeyStartMs(todayKey, TZ);
      const intervals: HomeyEnergyPriceInterval[] = todayValues.map((value, i) => ({
        periodStart: new Date(todayStartMs + i * 3600_000).toISOString(),
        periodEnd: new Date(todayStartMs + (i + 1) * 3600_000).toISOString(),
        value,
      }));
      setEnergyApi({
        fetchDynamicElectricityPrices: async ({ date }) => (
          date === todayKey
            ? { interval: 60, pricesPerInterval: intervals, priceUnit: 'EUR' }
            : { interval: 60, pricesPerInterval: [], priceUnit: 'EUR' }
        ),
        getCurrency: async () => ({ currency: 'EUR' }),
      });
    };

    it('persists the flat feed-in tariff on every hour, independent of the (even negative) import price', async () => {
      seedHomeyEnergy([0.3, -0.05, 0.2]);
      enableExport({ spotFactorPercent: 0, fixedInclVat: 0.08 }); // fixed 0.08/kWh feed-in

      const hours = flattenAllHours(await bootAndBuild());
      expect(hours.length).toBeGreaterThan(0);
      expect(hours.every((h) => h.exportPrice === 0.08)).toBe(true);
      // The negative import hour kept its negative total — export did not bleed in.
      expect(hours.some((h) => typeof h.total === 'number' && h.total < 0)).toBe(true);
    });

    it('persists no export price for a spot-linked config — there is no isolatable spot to link to', async () => {
      seedHomeyEnergy([0.3, 0.2]);
      enableExport({ spotFactorPercent: 90, fixedInclVat: 0.08 }); // spot-linked, but no spot here

      const hours = flattenAllHours(await bootAndBuild());
      expect(hours.length).toBeGreaterThan(0);
      expect(hours.every((h) => h.exportPrice === undefined)).toBe(true);
    });
  });
});
