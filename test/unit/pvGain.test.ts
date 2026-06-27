import { describe, expect, it } from 'vitest';
import {
  clearnessFactor,
  fitPvGain,
  MIN_PV_GAIN_SAMPLES,
  type PvGainTrainingPoint,
} from '../../packages/shared-domain/src/solar/pvGain';

const TRUE_GAIN = 0.0005; // kWh per (W/m²·h) → 800 W/m² clear sky ⇒ 0.4 kWh/h

// Deterministic synthetic hours: generation = trueGain × clearSky × clearness.
// Varies clear-sky and cloud across the set without Math.random (forbidden + flaky).
const syntheticPoints = (count: number, gain = TRUE_GAIN): PvGainTrainingPoint[] => (
  Array.from({ length: count }, (_, i) => {
    const clearSkyWm2 = 200 + (i * 137) % 800; // 200..1000, spread
    const cloudFraction = ((i * 17) % 100) / 100; // 0..0.99
    const generationKwh = gain * clearSkyWm2 * clearnessFactor(cloudFraction);
    return { clearSkyWm2, cloudFraction, generationKwh };
  })
);

describe('clearnessFactor', () => {
  it('maps cloud cover to the fraction of irradiance reaching the panels', () => {
    expect(clearnessFactor(0)).toBe(1);
    expect(clearnessFactor(0.5)).toBe(0.5);
    expect(clearnessFactor(1)).toBe(0);
    expect(clearnessFactor(-3)).toBe(1); // clamped
    expect(clearnessFactor(5)).toBe(0); // clamped
    expect(clearnessFactor(Number.NaN)).toBe(0); // unknown ⇒ assume overcast (no learn)
  });
});

describe('fitPvGain', () => {
  it('recovers the true device gain from clean synthetic hours', () => {
    const fit = fitPvGain(syntheticPoints(200));
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 9);
    expect(fit!.sampleCount).toBeGreaterThanOrEqual(MIN_PV_GAIN_SAMPLES);
    expect(fit!.confidence).toBe('high'); // many low-scatter samples
  });

  it('is robust to a minority of bad hours (outage / clipping)', () => {
    const points = syntheticPoints(200);
    // ~15% corrupted: some report zero (inverter offline), some double (clipping mismeasure).
    for (let i = 0; i < points.length; i += 7) points[i].generationKwh = 0;
    for (let i = 3; i < points.length; i += 11) points[i].generationKwh *= 2.5;
    const fit = fitPvGain(points);
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 5); // median holds the true gain
  });

  it('returns null while still learning (too few usable hours)', () => {
    expect(fitPvGain(syntheticPoints(MIN_PV_GAIN_SAMPLES - 1))).toBeNull();
  });

  it('ignores low-irradiance hours (dawn/dusk/overcast) below the floor', () => {
    // All hours have effective irradiance < 50 W/m² ⇒ none usable ⇒ null.
    const dim: PvGainTrainingPoint[] = Array.from({ length: 100 }, () => ({
      clearSkyWm2: 40, cloudFraction: 0, generationKwh: TRUE_GAIN * 40,
    }));
    expect(fitPvGain(dim)).toBeNull();
    // Overcast hours (clearness 0 ⇒ effective 0) are likewise dropped.
    const overcast: PvGainTrainingPoint[] = Array.from({ length: 100 }, () => ({
      clearSkyWm2: 900, cloudFraction: 1, generationKwh: 0,
    }));
    expect(fitPvGain(overcast)).toBeNull();
  });

  it('reports a lower confidence tier with fewer / noisier samples', () => {
    const small = fitPvGain(syntheticPoints(30));
    expect(small).not.toBeNull();
    expect(small!.confidence).toBe('low');
  });

  it('drops non-finite/negative inputs rather than poisoning the gain', () => {
    const points = syntheticPoints(60);
    points[0].generationKwh = Number.NaN;
    points[1].generationKwh = -5;
    // A NaN/undefined clear-sky must be filtered too — `NaN < floor` is false, so an
    // unguarded floor check would let it through and NaN-poison the median.
    points[2].clearSkyWm2 = Number.NaN;
    (points[3] as { clearSkyWm2: number }).clearSkyWm2 = undefined as unknown as number;
    const fit = fitPvGain(points);
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 6);
  });
});
