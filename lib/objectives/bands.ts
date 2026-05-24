import type { ObjectiveProfileKind } from '../../packages/contracts/src/objectiveProfileTypes';
import { resolveProfileConfidence } from './stats';
import type {
  ObjectiveProfileBand,
  ObjectiveProfileSampleObservation,
} from './types';

export const OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE = 64;
// Floor for any produced band — also gates `fitBandsFromSamples` on the whole
// buffer (must hold ≥2× this to even attempt a split). Prevents a freshly-split
// low-data band from dominating the estimate before it has enough evidence.
//
// SHS multi-band replay (2026-05-23, see
// `test/objectiveProfileBandsShsReplay.test.ts`): a 6-sample buffer with a
// textbook bimodal split — 3 samples at 0.30 kWh/°C, 3 at 0.50 kWh/°C — would
// reduce SSE by 99.94% at the natural boundary if the gate were bypassed (far
// above the 10% `MIN_SSE_REDUCTION_FRACTION` floor). The fitter still
// declines to split because each candidate cluster only holds 3 samples,
// below this floor. That is intentional: a 3-sample band with one outlier
// would skew the integrator without the law of large numbers to push back.
// The conservative path (global mean, no bands) is correct for sparse buffers
// — collect more samples per regime before trusting a split.
export const OBJECTIVE_PROFILE_MIN_BAND_SAMPLES = 8;
export const OBJECTIVE_PROFILE_MAX_BANDS = 4;

// EV charging tapers around 80% SoC (CV phase). Force a band edge there when
// data straddles it so the post-taper region is never averaged with the
// constant-power region below it.
const EV_SOC_TAPER_ANCHOR = 80;

// A candidate split only commits if it reduces the sum of squared error by at
// least this fraction of the parent band's SSE. Prevents fragmenting bands
// that are already homogeneous. Threshold validated by the SHS replay above
// — the bimodal regression's 99.94% reduction sits two orders of magnitude
// above this floor, so the SSE fraction is not the active constraint for
// undersized buffers; the min-samples floor above is.
const MIN_SSE_REDUCTION_FRACTION = 0.1;

// Cushion added to the topmost band's upper bound so the highest observed
// value is included when the estimator integrates up to a target at exactly
// that value (upperExclusive is exclusive at the boundary).
const BAND_UPPER_BOUND_EPSILON = 1e-9;

type SortedSamples = readonly ObjectiveProfileSampleObservation[];

export function appendSampleToBuffer(
  previous: ObjectiveProfileSampleObservation[] | undefined,
  next: ObjectiveProfileSampleObservation,
): ObjectiveProfileSampleObservation[] {
  const base = previous ?? [];
  const overflow = base.length + 1 - OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE;
  if (overflow <= 0) return [...base, next];
  return [...base.slice(overflow), next];
}

export function fitBandsFromSamples(params: {
  samples: ObjectiveProfileSampleObservation[];
  kind: ObjectiveProfileKind;
}): ObjectiveProfileBand[] | undefined {
  const { samples, kind } = params;
  if (samples.length < OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2) return undefined;
  const sorted = [...samples].sort((left, right) => left.inputValue - right.inputValue);
  const initial = [buildBandFromSlice(sorted, 0, sorted.length)];
  const anchored = kind === 'ev_soc' ? applyEvAnchorSplit(sorted, initial) : initial;
  return greedyRefine(sorted, anchored);
}

function greedyRefine(
  sorted: SortedSamples,
  bands: ObjectiveProfileBand[],
): ObjectiveProfileBand[] {
  let current = bands;
  while (current.length < OBJECTIVE_PROFILE_MAX_BANDS) {
    const candidate = pickBestSplit(sorted, current);
    if (!candidate) break;
    current = applySplit(sorted, current, candidate);
  }
  return current;
}

type SplitCandidate = {
  bandIndex: number;
  splitInputValue: number;
  leftSliceEnd: number;
  parentStart: number;
  parentEnd: number;
  sseReduction: number;
};

function pickBestSplit(
  sorted: SortedSamples,
  bands: ObjectiveProfileBand[],
): SplitCandidate | null {
  let best: SplitCandidate | null = null;
  for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
    const range = sliceRangeForBand(sorted, bands[bandIndex]);
    if (range.end - range.start < OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2) continue;
    const candidate = bestSplitWithinRange(sorted, range, bandIndex);
    if (candidate && (!best || candidate.sseReduction > best.sseReduction)) {
      best = candidate;
    }
  }
  return best;
}

function bestSplitWithinRange(
  sorted: SortedSamples,
  range: { start: number; end: number },
  bandIndex: number,
): SplitCandidate | null {
  const parentSse = computeSse(sorted, range.start, range.end);
  const minReduction = parentSse * MIN_SSE_REDUCTION_FRACTION;
  let best: SplitCandidate | null = null;
  const firstSplit = range.start + OBJECTIVE_PROFILE_MIN_BAND_SAMPLES;
  const lastSplit = range.end - OBJECTIVE_PROFILE_MIN_BAND_SAMPLES;
  for (let splitIdx = firstSplit; splitIdx <= lastSplit; splitIdx += 1) {
    // Cluster identical inputValues into the left side so the boundary lands
    // on a value not shared across sides.
    if (sorted[splitIdx].inputValue === sorted[splitIdx - 1].inputValue) continue;
    const leftSse = computeSse(sorted, range.start, splitIdx);
    const rightSse = computeSse(sorted, splitIdx, range.end);
    const reduction = parentSse - (leftSse + rightSse);
    if (reduction <= minReduction) continue;
    if (!best || reduction > best.sseReduction) {
      best = {
        bandIndex,
        splitInputValue: sorted[splitIdx].inputValue,
        leftSliceEnd: splitIdx,
        parentStart: range.start,
        parentEnd: range.end,
        sseReduction: reduction,
      };
    }
  }
  return best;
}

function applySplit(
  sorted: SortedSamples,
  bands: ObjectiveProfileBand[],
  candidate: SplitCandidate,
): ObjectiveProfileBand[] {
  const replaced = bands[candidate.bandIndex];
  const leftStats = buildBandFromSlice(sorted, candidate.parentStart, candidate.leftSliceEnd);
  const rightStats = buildBandFromSlice(sorted, candidate.leftSliceEnd, candidate.parentEnd);
  const left: ObjectiveProfileBand = {
    ...leftStats,
    lowerInclusive: replaced.lowerInclusive,
    upperExclusive: candidate.splitInputValue,
  };
  const right: ObjectiveProfileBand = {
    ...rightStats,
    lowerInclusive: candidate.splitInputValue,
    upperExclusive: replaced.upperExclusive,
  };
  const next: ObjectiveProfileBand[] = [];
  for (let i = 0; i < bands.length; i += 1) {
    if (i === candidate.bandIndex) {
      next.push(left);
      next.push(right);
    } else {
      next.push(bands[i]);
    }
  }
  return next;
}

function applyEvAnchorSplit(
  sorted: SortedSamples,
  initial: ObjectiveProfileBand[],
): ObjectiveProfileBand[] {
  const anchorIdx = findFirstIndexAtOrAbove(sorted, EV_SOC_TAPER_ANCHOR);
  if (anchorIdx === null) return initial;
  const leftCount = anchorIdx;
  const rightCount = sorted.length - anchorIdx;
  if (leftCount < OBJECTIVE_PROFILE_MIN_BAND_SAMPLES) return initial;
  if (rightCount < OBJECTIVE_PROFILE_MIN_BAND_SAMPLES) return initial;
  const parent = initial[0];
  const leftStats = buildBandFromSlice(sorted, 0, anchorIdx);
  const rightStats = buildBandFromSlice(sorted, anchorIdx, sorted.length);
  return [
    { ...leftStats, lowerInclusive: parent.lowerInclusive, upperExclusive: EV_SOC_TAPER_ANCHOR },
    { ...rightStats, lowerInclusive: EV_SOC_TAPER_ANCHOR, upperExclusive: parent.upperExclusive },
  ];
}

function findFirstIndexAtOrAbove(sorted: SortedSamples, threshold: number): number | null {
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].inputValue >= threshold) return i;
  }
  return null;
}

function sliceRangeForBand(
  sorted: SortedSamples,
  band: ObjectiveProfileBand,
): { start: number; end: number } {
  let start = -1;
  let end = sorted.length;
  for (let i = 0; i < sorted.length; i += 1) {
    const v = sorted[i].inputValue;
    if (start < 0 && v >= band.lowerInclusive) start = i;
    if (v >= band.upperExclusive) {
      end = i;
      break;
    }
  }
  return { start: start < 0 ? sorted.length : start, end };
}

function buildBandFromSlice(
  sorted: SortedSamples,
  startIdx: number,
  endIdx: number,
): ObjectiveProfileBand {
  const { sampleCount, mean, m2 } = welfordKwhPerUnit(sorted, startIdx, endIdx);
  const lowerInclusive = sorted[startIdx].inputValue;
  const lastValue = sorted[endIdx - 1].inputValue;
  const upperExclusive = lastValue + BAND_UPPER_BOUND_EPSILON;
  return {
    lowerInclusive,
    upperExclusive,
    sampleCount,
    mean,
    m2,
    confidence: resolveProfileConfidence({ sampleCount, mean, m2 }),
  };
}

function computeSse(sorted: SortedSamples, startIdx: number, endIdx: number): number {
  return welfordKwhPerUnit(sorted, startIdx, endIdx).m2;
}

function welfordKwhPerUnit(
  sorted: SortedSamples,
  startIdx: number,
  endIdx: number,
): { sampleCount: number; mean: number; m2: number } {
  const sampleCount = endIdx - startIdx;
  let mean = 0;
  let m2 = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const value = sorted[i].kwhPerUnit;
    const n = i - startIdx + 1;
    const delta = value - mean;
    mean += delta / n;
    m2 += delta * (value - mean);
  }
  return { sampleCount, mean, m2 };
}
