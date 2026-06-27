import { describe, expect, it, vi } from 'vitest';
import { OpenMeteoIrradianceProvider, type GeoCoordinates } from '../../lib/solar/openMeteoIrradiance';

const HOUR_MS = 3_600_000;
const H0 = Date.UTC(2026, 5, 1, 10);
const H1 = Date.UTC(2026, 5, 1, 11);
const OSLO: GeoCoordinates = { latitude: 59.91, longitude: 10.75 };
// Open-Meteo radiation is a preceding-hour mean: stamps at H0/H1 key to H0−1h/H0.
const RESPONSE = { hourly: { time: [H0 / 1000, H1 / 1000], shortwave_radiation: [420, 350] } };

type FetchResult = { ok: boolean; json: () => Promise<unknown> };
const stubFetch = (impl: () => Promise<FetchResult>): typeof fetch => (impl as unknown as typeof fetch);
const okOnce = (body: unknown): FetchResult => ({ ok: true, json: async () => body });

describe('OpenMeteoIrradianceProvider', () => {
  it('fetches and exposes hourly radiation, undefined for unknown hours', async () => {
    const provider = new OpenMeteoIrradianceProvider({
      getCoordinates: () => OSLO,
      fetchImpl: stubFetch(async () => okOnce(RESPONSE)),
      userAgent: 'pels-test',
    });
    expect(await provider.refresh()).toBe('ok');
    expect(provider.getIrradiance(H0 - HOUR_MS)).toBe(420); // H0 stamp ⇒ H0−1h interval
    expect(provider.getIrradiance(H0)).toBe(350); // H1 stamp ⇒ H0 interval
    expect(provider.getIrradiance(H1)).toBeUndefined();
  });

  it('keeps the prior cache when a later refresh fails (HTTP not-ok)', async () => {
    let ok = true;
    const provider = new OpenMeteoIrradianceProvider({
      getCoordinates: () => OSLO,
      fetchImpl: stubFetch(async () => (ok ? okOnce(RESPONSE) : { ok: false, json: async () => ({}) })),
      userAgent: 'pels-test',
    });
    await provider.refresh();
    ok = false;
    expect(await provider.refresh()).toBe('failed');
    expect(provider.getIrradiance(H0 - HOUR_MS)).toBe(420); // unchanged
  });

  it('maps a network error to failed, leaving the cache empty', async () => {
    const provider = new OpenMeteoIrradianceProvider({
      getCoordinates: () => OSLO,
      fetchImpl: stubFetch(async () => { throw new Error('network'); }),
      userAgent: 'pels-test',
    });
    expect(await provider.refresh()).toBe('failed');
    expect(provider.getIrradiance(H0 - HOUR_MS)).toBeUndefined();
  });

  it('never fetches without a usable location (null, undefined, or the 0,0 sentinel)', async () => {
    const fetchImpl = vi.fn();
    for (const coordinates of [null, undefined, { latitude: 0, longitude: 0 }]) {
      const provider = new OpenMeteoIrradianceProvider({
        getCoordinates: () => coordinates,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        userAgent: 'pels-test',
      });
      expect(await provider.refresh()).toBe('no_location');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
