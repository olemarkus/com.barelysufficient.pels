// Integration: PvForecastService learns a PV device's gain (one layer, MET mocked).
//
// A simulated PV "device" emits generation POWER that follows trueGain × clear-sky
// × clearness(cloud); those samples drive the real learning pipeline — generation
// integration (pvGenerationHistory), gain fit (pvGain), and forecast (pvForecast)
// over the real clear-sky model — through the PvForecastService. The injected
// (outward) seams are the home coordinates, the MET cloud cover, and the generation
// samples. The acceptance is that the service LEARNS the device's gain from its own
// output and forecasts forward generation correctly.
//
// (The full SDK-boundary e2e — generation through the power-sample pipeline via
// createApp — lands with the live wiring; here the service layer is exercised directly.)
//
// Samples are aligned to the hour grid (5-min cadence), so each hour integrates to
// exactly trueGain × clear-sky × clearness with no boundary error — the learned
// gain therefore recovers the true gain essentially exactly.
import { describe, expect, it } from 'vitest';
import { PvForecastService, type GeoCoordinates, type PvCloudProvider } from '../../lib/solar/pvForecastService';
import { clearSkyGhiWm2 } from '../../packages/shared-domain/src/solar/clearSky';
import { clearnessFactor } from '../../packages/shared-domain/src/solar/pvGain';

const HOUR_MS = 3_600_000;
const OSLO = { latitude: 59.91, longitude: 10.75 };
const TRUE_GAIN = 0.00045; // kWh per (W/m²·h) — the device the system must learn

// Deterministic per-hour cloud cover (0..1) — no Math.random (forbidden + flaky).
const cloudAt = (hourStartMs: number): number => {
  const hourIndex = Math.floor(hourStartMs / HOUR_MS);
  return ((hourIndex * 23) % 100) / 100;
};
const mockClouds: PvCloudProvider = { getCloudFraction: (hourStartMs) => cloudAt(hourStartMs) };

const clearSkyMidHour = (hourStartMs: number): number => (
  clearSkyGhiWm2(OSLO.latitude, OSLO.longitude, hourStartMs + HOUR_MS / 2)
);
const trueGenerationKwh = (hourStartMs: number): number => (
  TRUE_GAIN * clearSkyMidHour(hourStartMs) * clearnessFactor(cloudAt(hourStartMs))
);
// Constant power over the hour whose energy equals the hour's true generation
// (kWh over 1 h ⇒ kW ⇒ ×1000 W).
const trueGenerationW = (hourStartMs: number): number => trueGenerationKwh(hourStartMs) * 1000;

describe('Learning a PV device (MET mocked)', () => {
  it('learns the device gain from recorded generation + cloud, then forecasts forward', () => {
    const service = new PvForecastService({ getCoordinates: () => OSLO, clouds: mockClouds });

    // Drive ~14 June days (long Oslo daylight) of grid-aligned 5-min samples.
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 14;
    const stepMs = 5 * 60_000;
    for (let t = startMs; t < startMs + days * 24 * HOUR_MS; t += stepMs) {
      service.recordSample(trueGenerationW(Math.floor(t / HOUR_MS) * HOUR_MS), t);
    }

    // The device's gain has been learned from its own output.
    const fit = service.getFit();
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 7);
    expect(fit!.sampleCount).toBeGreaterThanOrEqual(24);
    expect(fit!.confidence).toBe('high'); // many low-scatter daylight hours

    // Forecast the next day; each hour matches the truth, days generate, nights don't.
    const nextDayStart = startMs + days * 24 * HOUR_MS;
    const forwardHours = Array.from({ length: 24 }, (_, h) => nextDayStart + h * HOUR_MS);
    const forecast = service.forecast(forwardHours);
    expect(forecast).toHaveLength(24);
    for (const hour of forecast) {
      expect(hour.generationKwh).toBeCloseTo(trueGenerationKwh(hour.hourStartMs), 5);
    }
    expect(forecast.some((h) => h.generationKwh > 0.1)).toBe(true); // real daytime generation
    expect(forecast.some((h) => h.generationKwh === 0)).toBe(true); // night
  });

  it('does not forecast until the device is learned (returns empty while cold)', () => {
    const service = new PvForecastService({ getCoordinates: () => OSLO, clouds: mockClouds });
    const startMs = Date.UTC(2026, 5, 1, 0);
    // Only a couple of hours of data — below the learning threshold.
    for (let t = startMs; t < startMs + 3 * HOUR_MS; t += 5 * 60_000) {
      service.recordSample(trueGenerationW(Math.floor(t / HOUR_MS) * HOUR_MS), t);
    }
    expect(service.getFit()).toBeNull();
    expect(service.forecast([startMs + 100 * HOUR_MS])).toEqual([]);
  });

  it('fits as soon as geolocation appears, without needing a fresh sample', () => {
    let coordinates: GeoCoordinates | null = null; // location not yet known at boot
    const service = new PvForecastService({ getCoordinates: () => coordinates, clouds: mockClouds });
    const startMs = Date.UTC(2026, 5, 1, 0);
    for (let t = startMs; t < startMs + 14 * 24 * HOUR_MS; t += 5 * 60_000) {
      service.recordSample(trueGenerationW(Math.floor(t / HOUR_MS) * HOUR_MS), t);
    }
    expect(service.getFit()).toBeNull(); // no location ⇒ no fit (and not cached as null)

    coordinates = OSLO; // geolocation appears — no further samples
    const fit = service.getFit();
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 7);
  });

  it('recomputes the fit when geolocation changes (cache is keyed by location)', () => {
    let coordinates: GeoCoordinates = OSLO;
    const service = new PvForecastService({ getCoordinates: () => coordinates, clouds: mockClouds });
    const startMs = Date.UTC(2026, 5, 1, 0);
    for (let t = startMs; t < startMs + 14 * 24 * HOUR_MS; t += 5 * 60_000) {
      service.recordSample(trueGenerationW(Math.floor(t / HOUR_MS) * HOUR_MS), t);
    }
    const osloGain = service.getFit()!.gainKwhPerWm2;
    expect(osloGain).toBeCloseTo(TRUE_GAIN, 7);

    // Same generation data, very different latitude ⇒ different clear-sky ⇒ the
    // re-derived gain differs. A stale cache would have returned the Oslo gain.
    coordinates = { latitude: 35, longitude: 10.75 };
    const movedGain = service.getFit()!.gainKwhPerWm2;
    expect(movedGain).toBeGreaterThan(0);
    expect(Math.abs(movedGain - osloGain) / osloGain).toBeGreaterThan(0.05);
  });

  it('detects an in-place coordinate mutation (cache snapshots lat/lon)', () => {
    const live: GeoCoordinates = { latitude: OSLO.latitude, longitude: OSLO.longitude };
    const service = new PvForecastService({ getCoordinates: () => live, clouds: mockClouds });
    const startMs = Date.UTC(2026, 5, 1, 0);
    for (let t = startMs; t < startMs + 14 * 24 * HOUR_MS; t += 5 * 60_000) {
      service.recordSample(trueGenerationW(Math.floor(t / HOUR_MS) * HOUR_MS), t);
    }
    const osloGain = service.getFit()!.gainKwhPerWm2;
    live.latitude = 35; // mutate the SAME object the provider returns
    const movedGain = service.getFit()!.gainKwhPerWm2;
    expect(Math.abs(movedGain - osloGain) / osloGain).toBeGreaterThan(0.05);
  });
});
