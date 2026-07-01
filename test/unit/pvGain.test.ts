import { describe, expect, it } from 'vitest';
import {
  fitPvGain,
  MIN_PV_GAIN_SAMPLES,
  PV_GAIN_CLAMP_DOMINANCE_RATIO,
  PV_GAIN_CLAMP_QUANTILE,
  type PvGainTrainingPoint,
} from '../../packages/shared-domain/src/solar/pvGain';

const TRUE_GAIN = 0.0005; // kWh per (W/m²·h) → 800 W/m² ⇒ 0.4 kWh/h

// Deterministic synthetic hours: generation = trueGain × irradiance. Varies
// irradiance across the set without Math.random (forbidden + flaky).
const syntheticPoints = (count: number, gain = TRUE_GAIN): PvGainTrainingPoint[] => (
  Array.from({ length: count }, (_, i) => {
    const irradianceWm2 = 100 + (i * 137) % 800; // 100..900
    return { irradianceWm2, generationKwh: gain * irradianceWm2 };
  })
);

const withEvidence = (
  points: PvGainTrainingPoint[],
  netEvidence: 'unclamped' | 'suspect',
): PvGainTrainingPoint[] => points.map((p) => ({ ...p, netEvidence }));

// Reference copy of the pre-segmentation fitPvGain (median over all valid gains)
// — the mode-3 regression pin asserts EXACT equality against it.
const legacyReferenceFit = (points: readonly PvGainTrainingPoint[]) => {
  const gains: number[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.irradianceWm2) || point.irradianceWm2 < 50) continue;
    if (!Number.isFinite(point.generationKwh) || point.generationKwh < 0) continue;
    gains.push(point.generationKwh / point.irradianceWm2);
  }
  if (gains.length < MIN_PV_GAIN_SAMPLES) return null;
  const sorted = [...gains].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const gain = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  if (!Number.isFinite(gain) || gain <= 0) return null;
  const deviations = gains.map((g) => Math.abs(g - gain)).sort((a, b) => a - b);
  const dMid = Math.floor(deviations.length / 2);
  const mad = deviations.length % 2 === 0 ? (deviations[dMid - 1] + deviations[dMid]) / 2 : deviations[dMid];
  const relativeScatter = mad / gain;
  const confidence = ((): 'low' | 'medium' | 'high' => {
    if (gains.length >= 168 && relativeScatter <= 0.15) return 'high';
    if (gains.length >= 72 && relativeScatter <= 0.25) return 'medium';
    return 'low';
  })();
  return { gainKwhPerWm2: gain, sampleCount: gains.length, relativeScatter, confidence };
};

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

  it('without segmentation evidence the fit is EXACTLY the legacy median (regression pin)', () => {
    // Noisy but deterministic: gains vary ±2% around TRUE_GAIN so median/MAD are
    // non-trivial. No point carries netEvidence ⇒ mode 3 must be byte-identical.
    const points = syntheticPoints(97).map((p, i) => ({
      ...p, generationKwh: p.generationKwh * (1 + ((i % 5) - 2) * 0.01),
    }));
    const reference = legacyReferenceFit(points);
    expect(reference).not.toBeNull();
    expect(fitPvGain(points)).toEqual({ ...reference!, trainingMode: 'unsegmented_median' });
  });

  it('trains the median on unclamped hours alone once enough exist', () => {
    // Clamped hours read at 40% of the true gain; exactly MIN unclamped hours exist.
    const suspects = withEvidence(syntheticPoints(150, TRUE_GAIN * 0.4), 'suspect');
    const unclamped = withEvidence(syntheticPoints(MIN_PV_GAIN_SAMPLES, TRUE_GAIN), 'unclamped');
    const fit = fitPvGain([...suspects, ...unclamped]);
    expect(fit).not.toBeNull();
    expect(fit!.trainingMode).toBe('unclamped_median');
    expect(fit!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 9);
    expect(fit!.sampleCount).toBe(MIN_PV_GAIN_SAMPLES);
    // Confidence thresholds apply to the UNCLAMPED pool size, not the total.
    expect(fit!.confidence).toBe('low');
  });

  it('reaches medium/high confidence from the unclamped pool size', () => {
    const suspects = withEvidence(syntheticPoints(50, TRUE_GAIN * 0.4), 'suspect');
    const unclamped = withEvidence(syntheticPoints(200, TRUE_GAIN), 'unclamped');
    const fit = fitPvGain([...suspects, ...unclamped]);
    expect(fit!.trainingMode).toBe('unclamped_median');
    expect(fit!.confidence).toBe('high');
  });

  it('zero-export home: falls back to the upper quantile of the EVIDENCE-BEARING gains', () => {
    // A clamp-dominated home: 200 suspect hours whose apparent gains spread from
    // 20%..100% of true (the clamp binds by differing amounts), plus hot legacy
    // 'unknown' hours that must be EXCLUDED from the quantile pool — pre-upgrade
    // history must not set the quantile.
    const suspects = syntheticPoints(200).map((p, i) => ({
      ...p,
      generationKwh: p.generationKwh * (0.2 + 0.8 * ((i * 37) % 100) / 99),
      netEvidence: 'suspect' as const,
    }));
    const unknowns = syntheticPoints(10, TRUE_GAIN * 3);
    const fit = fitPvGain([...suspects, ...unknowns]);
    expect(fit).not.toBeNull();
    expect(fit!.trainingMode).toBe('clamp_aware_quantile');
    expect(fit!.sampleCount).toBe(200); // pool = evidence-bearing gains, unknowns excluded
    // Nearest-rank P90 of the evidence pool, computed independently:
    const evidenceGains = suspects.map((p) => p.generationKwh / p.irradianceWm2).sort((a, b) => a - b);
    const expected = evidenceGains[
      Math.min(evidenceGains.length - 1, Math.ceil(PV_GAIN_CLAMP_QUANTILE * evidenceGains.length) - 1)
    ];
    expect(fit!.gainKwhPerWm2).toBe(expected);
    // The whole point: the quantile sits well above the clamped median…
    const mid = evidenceGains[Math.floor(evidenceGains.length / 2)];
    expect(fit!.gainKwhPerWm2).toBeGreaterThan(mid);
    // …but is bounded by the best evidence-bearing hour observed — the 3×-gain
    // legacy hours sit above it and must be unreachable.
    expect(fit!.gainKwhPerWm2).toBeLessThanOrEqual(evidenceGains.at(-1)!);
  });

  it('exporting-home warm-up: mixed evidence without suspect dominance stays on the legacy median', () => {
    // An ordinary exporting (or battery) home part-way through evidence warm-up:
    // 24 balanced-load 'suspect' hours accrue alongside 23 'unclamped' hours (one
    // short of the unclamped-median bar) atop 200 legacy 'unknown' hours. Suspect
    // count clears MIN but NOT the 2× dominance ratio ⇒ no quantile jump — the
    // fit is exactly the legacy median over all valid gains.
    const unclamped = withEvidence(syntheticPoints(23, TRUE_GAIN), 'unclamped');
    const suspects = withEvidence(syntheticPoints(MIN_PV_GAIN_SAMPLES, TRUE_GAIN * 0.9), 'suspect');
    const unknowns = syntheticPoints(200, TRUE_GAIN);
    const points = [...unclamped, ...suspects, ...unknowns];
    expect(suspects.length).toBeLessThan(PV_GAIN_CLAMP_DOMINANCE_RATIO * unclamped.length);
    const fit = fitPvGain(points);
    expect(fit).not.toBeNull();
    expect(fit!.trainingMode).toBe('unsegmented_median');
    expect(fit!.sampleCount).toBe(247);
    expect(fit).toEqual({ ...legacyReferenceFit(points)!, trainingMode: 'unsegmented_median' });
  });

  it('quantile mode forces LOW confidence even on 200 tight samples (confidence trap pin)', () => {
    // 200 identical clamped gains: scatter 0, count 200 — resolveConfidence would
    // say 'high', which is precisely the wrong read on a clamped pool.
    const fit = fitPvGain(withEvidence(syntheticPoints(200, TRUE_GAIN * 0.3), 'suspect'));
    expect(fit).not.toBeNull();
    expect(fit!.trainingMode).toBe('clamp_aware_quantile');
    expect(fit!.confidence).toBe('low');
    expect(fit!.relativeScatter).toBe(0);
  });

  it('returns null for a non-positive gain in every mode', () => {
    const dead = (points: PvGainTrainingPoint[]): PvGainTrainingPoint[] => (
      points.map((p) => ({ ...p, generationKwh: 0 }))
    );
    expect(fitPvGain(dead(syntheticPoints(60)))).toBeNull();
    expect(fitPvGain(withEvidence(dead(syntheticPoints(60)), 'suspect'))).toBeNull();
    expect(fitPvGain(withEvidence(dead(syntheticPoints(60)), 'unclamped'))).toBeNull();
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
