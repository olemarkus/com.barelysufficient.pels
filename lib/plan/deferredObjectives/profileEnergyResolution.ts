import type { PowerTrackerState } from '../../core/powerTracker';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../packages/shared-domain/src/objectiveProfileBootstrap';
import type {
  DeviceObjectiveProfile,
  ObjectiveProfileBand,
  ObjectiveProfileConfidence,
  ObjectiveProfileStat,
} from '../../core/objectiveProfileTypes';
import type { DeferredObjectiveEnforcement, DeferredObjectiveKind } from './types';

export type DeferredObjectiveKwhPerUnitSource = 'learned' | 'bootstrap';

export type DeferredObjectiveEnergyResolution = {
  // Planned energy the horizon planner books hours against. This is the
  // *buffered* figure (`mean + k·σ` per integrated band), so a device whose
  // energy-per-unit varies a lot reserves more time automatically. Equals
  // `energyExpectedKWh` when there is no usable variance (cold-start, bootstrap,
  // or a perfectly steady device).
  energyNeededKWh: number;
  // Mean-based estimate (no buffer). The honest "expected" figure; PR-2 UI
  // renders `energyExpectedKWh…energyNeededKWh` as a range. Kept distinct from
  // `energyNeededKWh` so the planner can be conservative while the displayed
  // learned rate (`kWhPerUnit`) and the low end of the range stay at the mean.
  energyExpectedKWh: number;
  kWhPerUnit: number | null;
  rateConfidence: string | null;
  // Band-aware confidence for the smart-task chip. Aggregated from the bands
  // actually integrated for this resolution: if every qualifying band that
  // overlaps `[current, target]` is medium+ and they cover the range, this is
  // `min(band.confidence)`. Otherwise falls back to the global
  // `kwhPerUnit.confidence`. Honest about whether the *model in use* is well
  // supported, not just about per-sample variance — which on thermal devices
  // stays above CV 0.75 effectively forever.
  displayConfidence: ObjectiveProfileConfidence | null;
  // null when the resolution did not consult a profile, e.g. when the target
  // is already satisfied and we short-circuit `energyNeededKWh` to zero.
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
  reasonCode: null;
} | {
  energyNeededKWh: null;
  energyExpectedKWh: null;
  kWhPerUnit: null;
  rateConfidence: null;
  displayConfidence: null;
  kwhPerUnitSource: null;
  reasonCode: 'objective_missing_capacity';
};

// Bands with fewer than this many samples lean on the global mean for their
// portion of the integration — keeps a freshly-split low-data band from
// dominating the estimate before it has enough evidence.
const MIN_BAND_SAMPLES_FOR_INTEGRATION = 4;

// Variance buffer: the planner books hours against `mean + k·SE` rather than the
// bare mean, so while the learned rate is still uncertain the objective reserves
// more time automatically instead of producing a hard `cannot_meet` off an
// optimistic, under-sampled estimate.
//
// SE is the *standard error of the mean* (σ/√n), not the per-sample σ. This is a
// deliberate choice: σ on a thermal device stays high effectively forever (CV
// > 0.75), so a σ-based buffer would be permanent *and* would jitter the booked
// hours as σ wobbles during early learning, churning replans. SE instead hedges
// uncertainty about the *mean*, so the buffer is largest while learning and
// fades smoothly toward zero as samples accumulate — a well-learned device
// plans at the mean. The per-cycle replan is the steady-state safety net: a
// worse-than-mean hour leaves more `remainingUnits`, so the next cycle books
// more hours while slack remains.
//
// `k` depends on enforcement: a hard deadline reserves a wider margin (~95% CI
// on the mean at k=2); a soft objective biases gently. Temperature objectives
// are always soft (only EV SoC may be hard). These are deliberately
// conservative, reversible tuning constants — see PR description.
const BUFFER_K_HARD = 2;
const BUFFER_K_SOFT = 1;
// Below this sample count even the standard error is untrustworthy, so we plan
// at the mean (range collapses to a single figure — the honest cold-start
// behaviour). EV cold-start is handled separately by the bootstrap path.
const MIN_SAMPLES_FOR_BUFFER = 4;
// Hard cap so a pathological estimate cannot explode the booked energy.
const MAX_BUFFER_MULTIPLIER = 2;

const resolveBufferK = (enforcement: DeferredObjectiveEnforcement): number => (
  enforcement === 'hard' ? BUFFER_K_HARD : BUFFER_K_SOFT
);

// Welford sample standard deviation. Shared by the global stat and per-band
// stats — both carry `m2` + `sampleCount`.
const sampleStdDev = (stat: { m2: number; sampleCount: number }): number => (
  stat.sampleCount > 1 ? Math.sqrt(Math.max(0, stat.m2 / (stat.sampleCount - 1))) : 0
);

const bufferedRate = (params: {
  mean: number;
  sigma: number;
  sampleCount: number;
  k: number;
}): number => {
  const { mean, sigma, sampleCount, k } = params;
  if (sampleCount < MIN_SAMPLES_FOR_BUFFER || sigma <= 0) return mean;
  // Standard error of the mean: shrinks as √n grows, so the buffer fades with
  // learning rather than persisting (and jittering) on a high-σ device.
  const standardError = sigma / Math.sqrt(sampleCount);
  return Math.min(mean + k * standardError, mean * MAX_BUFFER_MULTIPLIER);
};

export const resolveProfileEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objectiveKind: DeferredObjectiveKind;
  enforcement: DeferredObjectiveEnforcement;
  remainingUnits: number;
  currentValue?: number;
}): DeferredObjectiveEnergyResolution => {
  const profile = params.powerTracker.objectiveProfiles?.[params.deviceId];
  const kWhPerUnit = profile?.kind === params.objectiveKind ? profile.kwhPerUnit : undefined;
  if (kWhPerUnit && Number.isFinite(kWhPerUnit.mean) && kWhPerUnit.mean > 0) {
    return buildLearnedResolution({
      profile,
      kWhPerUnit,
      remainingUnits: params.remainingUnits,
      currentValue: params.currentValue,
      k: resolveBufferK(params.enforcement),
    });
  }
  // Bootstrap fallback for EV SoC objectives: SoC reporting depends on a
  // plugged-in charge session, so a learned `kwhPerUnit` often isn't available
  // when the user first sets a deadline. Use a conservative-high default so
  // the planner can produce a useful allocation immediately; the very next
  // accepted profile sample takes over and an automatic `rate_refined`
  // revision is written when the allocation shifts.
  if (params.objectiveKind === 'ev_soc') {
    const bootstrapEnergyKWh = params.remainingUnits * BOOTSTRAP_EV_SOC_KWH_PER_PERCENT;
    return {
      // No learned σ yet, so the planned and expected figures coincide — the
      // bootstrap constant is already conservative-high.
      energyNeededKWh: bootstrapEnergyKWh,
      energyExpectedKWh: bootstrapEnergyKWh,
      kWhPerUnit: BOOTSTRAP_EV_SOC_KWH_PER_PERCENT,
      rateConfidence: null,
      displayConfidence: null,
      kwhPerUnitSource: 'bootstrap',
      reasonCode: null,
    };
  }
  return {
    energyNeededKWh: null,
    energyExpectedKWh: null,
    kWhPerUnit: null,
    rateConfidence: null,
    displayConfidence: null,
    kwhPerUnitSource: null,
    reasonCode: 'objective_missing_capacity',
  };
};

const buildLearnedResolution = (params: {
  profile: DeviceObjectiveProfile | undefined;
  kWhPerUnit: ObjectiveProfileStat;
  remainingUnits: number;
  currentValue: number | undefined;
  k: number;
}): DeferredObjectiveEnergyResolution => {
  const { profile, kWhPerUnit, remainingUnits, currentValue, k } = params;
  const globalMean = kWhPerUnit.mean;
  const globalSigma = sampleStdDev(kWhPerUnit);
  const globalSampleCount = kWhPerUnit.sampleCount;
  const banded = integrateBands({
    bands: profile?.bands,
    globalMean,
    globalSigma,
    globalSampleCount,
    remainingUnits,
    currentValue,
    k,
  });
  const energyExpectedKWh = banded?.energyExpectedKWh ?? remainingUnits * globalMean;
  const energyNeededKWh = banded?.energyPlannedKWh
    ?? remainingUnits * bufferedRate({ mean: globalMean, sigma: globalSigma, sampleCount: globalSampleCount, k });
  // Displayed learned rate stays at the *expected* mean (integrated total over
  // remainingUnits) so "Energy needed per °C" reflects what PELS measured, not
  // the planning buffer; for the unbanded fallback this collapses to globalMean.
  const effectiveKwhPerUnit = remainingUnits > 0 ? energyExpectedKWh / remainingUnits : globalMean;
  return {
    energyNeededKWh,
    energyExpectedKWh,
    kWhPerUnit: effectiveKwhPerUnit,
    rateConfidence: kWhPerUnit.confidence,
    displayConfidence: resolveDisplayConfidence({
      bands: profile?.bands,
      globalConfidence: kWhPerUnit.confidence,
      remainingUnits,
      currentValue,
    }),
    kwhPerUnitSource: 'learned',
    reasonCode: null,
  };
};

// Aggregates per-band confidence into a single value for the smart-task chip.
// Rules:
//   - No bands, or fewer than `MIN_BAND_SAMPLES_FOR_INTEGRATION` samples on
//     any band overlapping `[current, target]` → fall back to global.
//   - Bands cover the integration interval (within a small tolerance) AND
//     every overlapping band qualifies → `min(band.confidence)`.
//   - Otherwise (band gaps, or interval extends outside any band) → fall back
//     to global.
//
// Producer-side per `feedback_layering_resolution_in_producer.md`: the UI
// consumes the flat value and never branches on bands or per-band fields.
export const resolveDisplayConfidence = (params: {
  bands: ObjectiveProfileBand[] | undefined;
  globalConfidence: ObjectiveProfileConfidence;
  remainingUnits: number;
  currentValue: number | undefined;
}): ObjectiveProfileConfidence => {
  const { bands, globalConfidence, remainingUnits, currentValue } = params;
  if (!bands || bands.length === 0) return globalConfidence;
  if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) return globalConfidence;
  if (remainingUnits <= 0) return globalConfidence;
  const targetValue = currentValue + remainingUnits;
  let coveredUnits = 0;
  const overlappingConfidences: ObjectiveProfileConfidence[] = [];
  for (const band of bands) {
    const overlapLow = Math.max(band.lowerInclusive, currentValue);
    const overlapHigh = Math.min(band.upperExclusive, targetValue);
    const overlap = Math.max(0, overlapHigh - overlapLow);
    if (overlap <= 0) continue;
    // Any underpopulated band that touches the interval forces the fallback —
    // we can't claim the model in use is well supported if even one slice of
    // it leans on the global mean.
    if (band.sampleCount < MIN_BAND_SAMPLES_FOR_INTEGRATION) return globalConfidence;
    overlappingConfidences.push(band.confidence);
    coveredUnits += overlap;
  }
  if (overlappingConfidences.length === 0) return globalConfidence;
  // Tolerance for "fully covered" — sub-unit jitter from float math shouldn't
  // flip the answer.
  const COVERAGE_TOLERANCE = 1e-6;
  if (coveredUnits + COVERAGE_TOLERANCE < remainingUnits) return globalConfidence;
  return minConfidence(overlappingConfidences);
};

const CONFIDENCE_RANK: Record<ObjectiveProfileConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const minConfidence = (values: ObjectiveProfileConfidence[]): ObjectiveProfileConfidence => {
  let lowest: ObjectiveProfileConfidence = values[0];
  for (const value of values) {
    if (CONFIDENCE_RANK[value] < CONFIDENCE_RANK[lowest]) lowest = value;
  }
  return lowest;
};

const integrateBands = (params: {
  bands: ObjectiveProfileBand[] | undefined;
  globalMean: number;
  globalSigma: number;
  globalSampleCount: number;
  remainingUnits: number;
  currentValue: number | undefined;
  k: number;
}): { energyExpectedKWh: number; energyPlannedKWh: number } | null => {
  const {
    bands, globalMean, globalSigma, globalSampleCount, remainingUnits, currentValue, k,
  } = params;
  if (!bands || bands.length === 0) return null;
  if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) return null;
  if (remainingUnits <= 0) return { energyExpectedKWh: 0, energyPlannedKWh: 0 };
  const targetValue = currentValue + remainingUnits;
  let expected = 0;
  let planned = 0;
  let coveredUnits = 0;
  for (const band of bands) {
    const overlap = computeOverlap(band, currentValue, targetValue);
    if (overlap <= 0) continue;
    // An underpopulated band leans on the global mean *and* the global buffer
    // for its slice — same fallback the expected estimate uses.
    const useBand = band.sampleCount >= MIN_BAND_SAMPLES_FOR_INTEGRATION;
    const mean = useBand ? band.mean : globalMean;
    const sigma = useBand ? sampleStdDev(band) : globalSigma;
    const sampleCount = useBand ? band.sampleCount : globalSampleCount;
    expected += overlap * mean;
    planned += overlap * bufferedRate({ mean, sigma, sampleCount, k });
    coveredUnits += overlap;
  }
  // Bands may not cover the entire [current, target] interval — anything
  // outside the observed range (e.g., target above the highest band edge or
  // current below the lowest) gets the global mean (buffered for the plan).
  const uncoveredUnits = Math.max(0, remainingUnits - coveredUnits);
  expected += uncoveredUnits * globalMean;
  planned += uncoveredUnits * bufferedRate({
    mean: globalMean, sigma: globalSigma, sampleCount: globalSampleCount, k,
  });
  return { energyExpectedKWh: expected, energyPlannedKWh: planned };
};

const computeOverlap = (
  band: ObjectiveProfileBand,
  currentValue: number,
  targetValue: number,
): number => {
  const overlapLow = Math.max(band.lowerInclusive, currentValue);
  const overlapHigh = Math.min(band.upperExclusive, targetValue);
  return Math.max(0, overlapHigh - overlapLow);
};
