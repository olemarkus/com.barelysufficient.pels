// Integration: PvForecastService learns a PV device's gain (one layer, irradiance mocked).
//
// A simulated PV "device" emits generation POWER that follows trueGain × irradiance;
// those samples drive the real learning pipeline — generation integration
// (pvGenerationHistory), gain fit (pvGain), and forecast (pvForecast) — through the
// PvForecastService. The injected (outward) seam is the irradiance provider (which
// in production is Open-Meteo shortwave radiation; here a deterministic mock) plus
// the generation samples. The acceptance is that the service LEARNS the device's
// gain from its own output and forecasts forward generation correctly.
//
// (The full SDK-boundary e2e — generation through the power-sample pipeline via
// createApp — lands with the live wiring; here the service layer is exercised directly.)
//
// Samples are aligned to the hour grid (5-min cadence), so each hour integrates to
// exactly trueGain × irradiance with no boundary error — the learned gain therefore
// recovers the true gain essentially exactly.
import { describe, expect, it } from 'vitest';
import { PvForecastService, type PvIrradianceProvider } from '../../lib/solar/pvForecastService';

const HOUR_MS = 3_600_000;
const TRUE_GAIN = 0.00045; // kWh per (W/m²·h) — the device the service must learn

// Deterministic hourly shortwave irradiance (W/m²): a daytime bell, zero at night.
const irradianceAt = (hourStartMs: number): number => {
  const hourOfDay = Math.floor(hourStartMs / HOUR_MS) % 24;
  const x = (hourOfDay - 12) / 6; // 0 at noon, ±1 at 06/18
  return Math.max(0, 1 - x * x) * 900; // 0..900 W/m²
};
const mockIrradiance: PvIrradianceProvider = { getIrradiance: (hourStartMs) => irradianceAt(hourStartMs) };

const trueGenerationKwh = (hourStartMs: number): number => TRUE_GAIN * irradianceAt(hourStartMs);
// Constant power over the hour whose energy equals the hour's true generation.
const trueGenerationW = (hourStartMs: number): number => trueGenerationKwh(hourStartMs) * 1000;

const recordDays = (
  service: PvForecastService,
  startMs: number,
  days: number,
  opts: { outputFactor?: number; netW?: number } = {},
): void => {
  const factor = opts.outputFactor ?? 1;
  for (let t = startMs; t < startMs + days * 24 * HOUR_MS; t += 5 * 60_000) {
    service.recordSample(factor * trueGenerationW(Math.floor(t / HOUR_MS) * HOUR_MS), t, opts.netW);
  }
};

describe('Learning a PV device (irradiance mocked)', () => {
  it('learns the device gain from recorded generation + irradiance, then forecasts forward', () => {
    const service = new PvForecastService({ irradiance: mockIrradiance });
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 18; // ~11 usable daylight hours/day ⇒ >168 hours ⇒ 'high' tier
    recordDays(service, startMs, days);

    const fit = service.getFit();
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 7);
    expect(fit!.sampleCount).toBeGreaterThanOrEqual(168);
    expect(fit!.confidence).toBe('high');

    const nextDayStart = startMs + days * 24 * HOUR_MS;
    const forwardHours = Array.from({ length: 24 }, (_, h) => nextDayStart + h * HOUR_MS);
    const forecast = service.forecast(forwardHours);
    expect(forecast).toHaveLength(24);
    for (const hour of forecast) {
      expect(hour.generationKwh).toBeCloseTo(trueGenerationKwh(hour.hourStartMs), 5);
    }
    expect(forecast.some((h) => h.generationKwh > 0.1)).toBe(true); // daytime
    expect(forecast.some((h) => h.generationKwh === 0)).toBe(true); // night
  });

  it('does not forecast until the device is learned (returns empty while cold)', () => {
    const service = new PvForecastService({ irradiance: mockIrradiance });
    const startMs = Date.UTC(2026, 5, 1, 0);
    recordDays(service, startMs, 1); // a single day — below the learning threshold
    expect(service.getFit()).toBeNull();
    expect(service.forecast([startMs + 100 * HOUR_MS])).toEqual([]);
  });

  it('segments training on net evidence: sustained import trains the median, a zero-export clamp the quantile', () => {
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 18;

    // Import-dominant home: PV never covers the house load — every sample carries
    // a deep positive net (+800 W) ⇒ hours are provably unclamped ⇒ the fit is the
    // plain median over them, at full confidence.
    const importHome = new PvForecastService({ irradiance: mockIrradiance });
    recordDays(importHome, startMs, days, { netW: 800 });
    const importFit = importHome.getFit();
    expect(importFit).not.toBeNull();
    expect(importFit!.trainingMode).toBe('unclamped_median');
    expect(importFit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 7);
    expect(importFit!.confidence).toBe('high');

    // Zero-export home: the inverter clamps output to house consumption — the
    // measured output is 40% of potential while net hovers at a +50 W standing
    // import (below the import-evidence bar) ⇒ every hour is clamp-suspect ⇒ the
    // fit falls back to the quantile, forced-low confidence. All clamped hours
    // read identically here, so the quantile equals the observed (clamped) gain —
    // it is bounded by what was actually seen.
    const clampedHome = new PvForecastService({ irradiance: mockIrradiance });
    recordDays(clampedHome, startMs, days, { outputFactor: 0.4, netW: 50 });
    const clampedFit = clampedHome.getFit();
    expect(clampedFit).not.toBeNull();
    expect(clampedFit!.trainingMode).toBe('clamp_aware_quantile');
    expect(clampedFit!.confidence).toBe('low');
    expect(clampedFit!.gainKwhPerWm2).toBeCloseTo(0.4 * TRUE_GAIN, 7);

    // forecast() consumes the learned gain identically in both modes — no
    // trainingMode branching downstream of the fit (observability only).
    const noon = startMs + days * 24 * HOUR_MS + 12 * HOUR_MS;
    expect(importHome.forecast([noon])[0].generationKwh)
      .toBeCloseTo(importFit!.gainKwhPerWm2 * irradianceAt(noon), 9);
    expect(clampedHome.forecast([noon])[0].generationKwh)
      .toBeCloseTo(clampedFit!.gainKwhPerWm2 * irradianceAt(noon), 9);
  });
});
