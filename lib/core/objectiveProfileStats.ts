import type {
  ObjectiveProfileConfidence,
  ObjectiveProfileStat,
} from './objectiveProfileTypes';

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
