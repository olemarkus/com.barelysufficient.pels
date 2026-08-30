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
import {
  emptyPvForecastServiceState,
  PvForecastService,
  type PvIrradianceProvider,
} from '../../lib/solar/pvForecastService';
import type { PvGainFit } from '../../packages/shared-domain/src/solar/pvGain';

const HOUR_MS = 3_600_000;
const TRUE_GAIN = 0.00045; // kWh per (W/m²·h) — the device the service must learn

// Deterministic hourly shortwave irradiance (W/m²): a daytime bell, zero at night.
const irradianceAt = (hourStartMs: number): number => {
  const hourOfDay = Math.floor(hourStartMs / HOUR_MS) % 24;
  const x = (hourOfDay - 12) / 6; // 0 at noon, ±1 at 06/18
  return Math.max(0, 1 - x * x) * 900; // 0..900 W/m²
};
const mockIrradiance: PvIrradianceProvider = {
  getIrradiance: (hourStartMs) => ({ kind: 'reported', irradianceWm2: irradianceAt(hourStartMs) }),
};

// The fitted arm, or a failed test — the assertions are about the gain, not
// about discriminating the answer.
const fittedGain = (service: PvForecastService): PvGainFit => {
  const learned = service.getFit();
  if (learned.kind !== 'fitted') throw new Error('expected a fitted gain, got: learning');
  return learned.fit;
};

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
    const service = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 18; // ~11 usable daylight hours/day ⇒ >168 hours ⇒ 'high' tier
    recordDays(service, startMs, days);

    const fit = fittedGain(service);
    expect(fit.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 7);
    expect(fit.sampleCount).toBeGreaterThanOrEqual(168);
    expect(fit.confidence).toBe('high');

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

  it('hasForwardForecast is false with a fit but no forward irradiance, and true once both exist', () => {
    // A fit restored from persistence outlives the in-memory irradiance
    // provider: if the location lookup or the startup refresh failed, the
    // provider answers nothing forward and `forecast()` skips every hour.
    // Provenance derived from `getFit()` alone would claim planning is using a
    // learned forecast it is not getting.
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 18;
    const forwardMs = startMs + days * 24 * HOUR_MS;

    const learned = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    recordDays(learned, startMs, days);
    expect(learned.getFit().kind).toBe('fitted');
    expect(learned.hasForwardForecast(forwardMs)).toBe(true);

    // Same learned state, but the provider has no forward irradiance.
    const blindProvider: PvIrradianceProvider = {
      getIrradiance: (hourStartMs) => (hourStartMs >= forwardMs
        ? { kind: 'absent' }
        : { kind: 'reported', irradianceWm2: irradianceAt(hourStartMs) }),
    };
    const blind = new PvForecastService({
      irradiance: blindProvider,
      initialState: learned.getState(),
    });
    expect(blind.getFit().kind).toBe('fitted');
    expect(blind.forecast([forwardMs])).toEqual([]);
    expect(blind.hasForwardForecast(forwardMs)).toBe(false);
  });

  it('hasForwardForecast is false while still cold (no fit at all)', () => {
    const service = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    expect(service.hasForwardForecast(Date.UTC(2026, 5, 1, 0))).toBe(false);
  });

  it('does not forecast until the device is learned (returns empty while cold)', () => {
    const service = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    const startMs = Date.UTC(2026, 5, 1, 0);
    recordDays(service, startMs, 1); // a single day — below the learning threshold
    expect(service.getFit()).toEqual({ kind: 'learning' });
    expect(service.forecast([startMs + 100 * HOUR_MS])).toEqual([]);
  });

  it('segments training on net evidence: sustained import trains the median, a zero-export clamp the quantile', () => {
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 18;

    // Import-dominant home: PV never covers the house load — every sample carries
    // a deep positive net (+800 W) ⇒ hours are provably unclamped ⇒ the fit is the
    // plain median over them, at full confidence.
    const importHome = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    recordDays(importHome, startMs, days, { netW: 800 });
    const importFit = fittedGain(importHome);
    expect(importFit.trainingMode).toBe('unclamped_median');
    expect(importFit.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 7);
    expect(importFit.confidence).toBe('high');

    // Zero-export home: the inverter clamps output to house consumption — the
    // measured output is 40% of potential while net hovers at a +50 W standing
    // import (below the import-evidence bar) ⇒ every hour is clamp-suspect ⇒ the
    // fit falls back to the quantile, forced-low confidence. All clamped hours
    // read identically here, so the quantile equals the observed (clamped) gain —
    // it is bounded by what was actually seen.
    const clampedHome = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    recordDays(clampedHome, startMs, days, { outputFactor: 0.4, netW: 50 });
    const clampedFit = fittedGain(clampedHome);
    expect(clampedFit.trainingMode).toBe('clamp_aware_quantile');
    expect(clampedFit.confidence).toBe('low');
    expect(clampedFit.gainKwhPerWm2).toBeCloseTo(0.4 * TRUE_GAIN, 7);

    // forecast() consumes the learned gain identically in both modes — no
    // trainingMode branching downstream of the fit (observability only).
    const noon = startMs + days * 24 * HOUR_MS + 12 * HOUR_MS;
    expect(importHome.forecast([noon])[0].generationKwh)
      .toBeCloseTo(importFit.gainKwhPerWm2 * irradianceAt(noon), 9);
    expect(clampedHome.forecast([noon])[0].generationKwh)
      .toBeCloseTo(clampedFit.gainKwhPerWm2 * irradianceAt(noon), 9);
  });
});

describe('mergeRecoveredState invariants (suspect-boot recovery)', () => {
  const T0 = Date.UTC(2026, 5, 21, 12, 0, 0); // an exact UTC hour-start
  const OLD_HOUR = String(T0 - 2 * HOUR_MS);
  const TAINT_HOUR = String(T0 - 3 * HOUR_MS);
  const recovered = {
    history: {
      lastSampleMs: T0 - 2 * HOUR_MS + 600_000,
      lastGenerationW: 800,
      lastNetW: -250, // SIGNED export anchor recorded before the crash
      hourly: { [OLD_HOUR]: { kwh: 0.3, coveredMs: HOUR_MS } },
      taintedHourStarts: { [TAINT_HOUR]: true as const },
    },
    irradianceByHour: { [OLD_HOUR]: 640 },
  };

  it('keeps recovered irradiance and taint, and travels the cursor triple as a unit from the live side', () => {
    const service = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    // Live samples WITHOUT a net reading: the live cursor exists but carries no
    // lastNetW. A field-wise merge would resurrect the recovered -250 anchor
    // and accrue net evidence over time the net was never observed.
    service.recordSample(1000, T0);
    service.recordSample(1000, T0 + 60_000);
    service.mergeRecoveredState(recovered);

    const state = service.getState();
    expect(state.irradianceByHour[OLD_HOUR]).toBe(640); // recovered irradiance survives
    expect(state.irradianceByHour[String(T0)]).toBe(irradianceAt(T0)); // live stamp survives too
    expect(state.history.taintedHourStarts?.[TAINT_HOUR]).toBe(true); // taint union
    expect(state.history.hourly[OLD_HOUR]).toEqual({ kwh: 0.3, coveredMs: HOUR_MS }); // recovered fills
    expect(state.history.lastSampleMs).toBe(T0 + 60_000); // live cursor wins…
    expect(state.history.lastGenerationW).toBe(1000);
    expect(state.history.lastNetW).toBeUndefined(); // …as a UNIT — no recovered lastNetW resurrected
  });

  it('adopts the recovered cursor triple when the live side has none (prune-dirty recovery)', () => {
    const service = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    service.mergeRecoveredState(recovered); // no live sample was ever folded
    const state = service.getState();
    expect(state.history.lastSampleMs).toBe(recovered.history.lastSampleMs);
    expect(state.history.lastGenerationW).toBe(800);
    expect(state.history.lastNetW).toBe(-250);
    expect(state.history.hourly).toEqual(recovered.history.hourly);
    expect(state.irradianceByHour).toEqual(recovered.irradianceByHour);
  });

  it('taints the RECOVERED cursor hour too — a near-complete bucket must not train across the crash hole', () => {
    // Persisted at :58 with 58 min of coverage; the crash hole runs :58→:01 of
    // the NEXT hour, so the live cursor hour never appears in recovered.hourly.
    // One-sided taint would let the 58-min bucket clear the 95% training gate
    // while silently missing the tail of its hour.
    const service = new PvForecastService({
      irradiance: mockIrradiance,
      initialState: emptyPvForecastServiceState(),
    });
    const crashHourMs = T0 - HOUR_MS; // 11:00, bucket covered to 11:58
    service.recordSample(1000, T0 + 60_000); // live resumes 12:01
    service.recordSample(1000, T0 + 120_000);
    service.mergeRecoveredState({
      history: {
        lastSampleMs: crashHourMs + 58 * 60_000, // cursor at 11:58
        lastGenerationW: 900,
        hourly: { [String(crashHourMs)]: { kwh: 0.9, coveredMs: 58 * 60_000 } },
      },
      irradianceByHour: {},
    });
    const state = service.getState();
    expect(state.history.taintedHourStarts?.[String(crashHourMs)]).toBe(true); // recovered-cursor boundary
    expect(state.history.hourly[String(crashHourMs)]).toEqual({ kwh: 0.9, coveredMs: 58 * 60_000 });
    expect(state.history.taintedHourStarts?.[String(T0)]).toBeUndefined(); // live bucket is honest — no taint
  });
});
