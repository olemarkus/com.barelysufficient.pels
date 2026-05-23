import type {
  ObjectiveProfileBand,
  ObjectiveProfileConfidence,
  ObjectiveProfileStat,
} from './types';

// Convenience wrapper for the profile orchestrator: rewrites a kWh/unit stat's
// `confidence` field to the band-aware value once bands are in scope, so the
// overall confidence reflects the pooled within-band residual rather than the
// global-mean RSD. No-op when bands are absent — `updateProfileStat`'s
// `resolveProfileConfidence` result stands.
export function applyBandedConfidence(
  stat: ObjectiveProfileStat | undefined,
  bands: ObjectiveProfileBand[] | undefined,
): ObjectiveProfileStat | undefined {
  if (!stat || !bands || bands.length === 0) return stat;
  return {
    ...stat,
    confidence: resolveBandedProfileConfidence({
      sampleCount: stat.sampleCount,
      mean: stat.mean,
      m2: stat.m2,
      bands,
    }),
  };
}

export function updateProfileStat(
  previous: ObjectiveProfileStat | undefined,
  value: number,
  observedAtMs: number,
): ObjectiveProfileStat {
  if (!previous || previous.sampleCount <= 0) {
    return {
      sampleCount: 1,
      mean: value,
      m2: 0,
      min: value,
      max: value,
      confidence: 'low',
      lastUpdatedMs: observedAtMs,
    };
  }
  const sampleCount = previous.sampleCount + 1;
  const delta = value - previous.mean;
  const mean = previous.mean + delta / sampleCount;
  const nextDelta = value - mean;
  const m2 = previous.m2 + delta * nextDelta;
  return {
    sampleCount,
    mean,
    m2,
    min: Math.min(previous.min, value),
    max: Math.max(previous.max, value),
    confidence: resolveProfileConfidence({ sampleCount, mean, m2 }),
    lastUpdatedMs: observedAtMs,
  };
}

export function resolveProfileConfidence(params: {
  sampleCount: number;
  mean: number;
  m2: number;
}): ObjectiveProfileConfidence {
  const { sampleCount, mean, m2 } = params;
  if (sampleCount < 4) return 'low';
  const variance = sampleCount > 1 ? m2 / (sampleCount - 1) : 0;
  const relativeStdDev = mean > 0 ? Math.sqrt(Math.max(0, variance)) / mean : Number.POSITIVE_INFINITY;
  if (sampleCount >= 10 && relativeStdDev <= 0.35) return 'high';
  return relativeStdDev <= 0.75 ? 'medium' : 'low';
}

// Band-aware overall-profile confidence. When the profile has fitted bands,
// each band's `m2` is the within-band noise *after* the band split explains the
// structural between-band variance — pool that and judge the relative-std-dev
// against the overall mean. This is the confidence the global model can't
// reach for multi-step devices, where the global `m2` is inflated by
// between-step spread (e.g. a heater with 1.2/1.7/2.9 kW steps mixes those
// kWh/°C values into one inflated variance even after the rate has converged
// tightly within each step). Falls back to the non-banded resolver when no
// bands exist; the per-band resolver itself is unchanged because each band's
// own m2 is already the within-band noise.
export function resolveBandedProfileConfidence(params: {
  sampleCount: number;
  mean: number;
  m2: number;
  bands: ObjectiveProfileBand[] | undefined;
}): ObjectiveProfileConfidence {
  const { sampleCount, mean, m2, bands } = params;
  if (!bands || bands.length === 0) {
    return resolveProfileConfidence({ sampleCount, mean, m2 });
  }
  const bandSampleTotal = bands.reduce((sum, band) => sum + band.sampleCount, 0);
  const residualDof = bandSampleTotal - bands.length;
  if (residualDof <= 0) {
    return resolveProfileConfidence({ sampleCount, mean, m2 });
  }
  // Use the *sample-weighted band mean* as the RSD reference, not the lifetime
  // running `mean`. Pooled `m2` is computed from buffered samples (≤ 64); when
  // the buffer distribution drifts from the lifetime distribution (e.g. recent
  // operation skewed toward one step) the two means diverge, and dividing by
  // the lifetime mean would compare within-band noise to a non-local reference.
  // The buffer-weighted mean is the honest central tendency for the pooled
  // within-band variance. Falls back to the lifetime `mean` if both are
  // non-positive.
  const weightedBandMean = bands.reduce(
    (sum, band) => sum + band.sampleCount * band.mean,
    0,
  ) / bandSampleTotal;
  const referenceMean = weightedBandMean > 0 ? weightedBandMean : mean;
  if (referenceMean <= 0) {
    return resolveProfileConfidence({ sampleCount, mean, m2 });
  }
  const pooledM2 = bands.reduce((sum, band) => sum + band.m2, 0);
  const pooledVariance = pooledM2 / residualDof;
  const relativeStdDev = Math.sqrt(Math.max(0, pooledVariance)) / referenceMean;
  if (bandSampleTotal >= 10 && relativeStdDev <= 0.35) return 'high';
  return relativeStdDev <= 0.75 ? 'medium' : 'low';
}
