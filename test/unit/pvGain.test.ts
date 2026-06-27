import { describe, expect, it } from 'vitest';
import { fitPvGain, MIN_PV_GAIN_SAMPLES, type PvGainTrainingPoint } from '../../packages/shared-domain/src/solar/pvGain';

const TRUE_GAIN = 0.0005; // kWh per (W/m²·h) → 800 W/m² ⇒ 0.4 kWh/h

// Deterministic synthetic hours: generation = trueGain × irradiance. Varies
// irradiance across the set without Math.random (forbidden + flaky).
const syntheticPoints = (count: number, gain = TRUE_GAIN): PvGainTrainingPoint[] => (
  Array.from({ length: count }, (_, i) => {
    const irradianceWm2 = 100 + (i * 137) % 800; // 100..900
    return { irradianceWm2, generationKwh: gain * irradianceWm2 };
  })
);

describe('fitPvGain', () => {
  it('recovers the true device gain from clean synthetic hours', () => {
    const fit = fitPvGain(syntheticPoints(200));
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 9);
    expect(fit!.sampleCount).toBeGreaterThanOrEqual(MIN_PV_GAIN_SAMPLES);
    expect(fit!.confidence).toBe('high');
  });

  it('is robust to a minority of bad hours (outage / clipping)', () => {
    const points = syntheticPoints(200);
    for (let i = 0; i < points.length; i += 7) points[i].generationKwh = 0; // inverter offline
    for (let i = 3; i < points.length; i += 11) points[i].generationKwh *= 2.5; // clipping mismeasure
    const fit = fitPvGain(points);
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 5); // median holds
  });

  it('returns null while still learning (too few usable hours)', () => {
    expect(fitPvGain(syntheticPoints(MIN_PV_GAIN_SAMPLES - 1))).toBeNull();
  });

  it('ignores hours below the irradiance floor (dawn/dusk/overcast)', () => {
    const dim: PvGainTrainingPoint[] = Array.from({ length: 100 }, () => ({
      irradianceWm2: 40, generationKwh: TRUE_GAIN * 40,
    }));
    expect(fitPvGain(dim)).toBeNull();
  });

  it('reports a lower confidence tier with fewer samples', () => {
    const small = fitPvGain(syntheticPoints(30));
    expect(small).not.toBeNull();
    expect(small!.confidence).toBe('low');
  });

  it('drops non-finite/negative inputs rather than poisoning the gain', () => {
    const points = syntheticPoints(60);
    points[0].generationKwh = Number.NaN;
    points[1].generationKwh = -5;
    points[2].irradianceWm2 = Number.NaN; // NaN < floor is false ⇒ must be filtered explicitly
    (points[3] as { irradianceWm2: number }).irradianceWm2 = undefined as unknown as number;
    const fit = fitPvGain(points);
    expect(fit).not.toBeNull();
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 6);
  });
});
