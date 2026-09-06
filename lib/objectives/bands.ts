import { resolveProfileConfidence } from './stats';
import type {
  ObjectiveProfileBand,
  ObjectiveProfileSampleObservation,
  ObjectiveProfileStat,
} from './types';

export const OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE = 64;

/**
 * How far back the buffer keeps an observation. The buffer is bounded by BOTH
 * this and the size cap above, and everything the profile knows about its
 * kWh/unit rate — the bands, the global stat, and the admission band in
 * `energyBand.ts` — is derived from it, so this one horizon governs all three.
 *
 * The size cap alone is not enough, and the gap it leaves is not cosmetic. A
 * refused window never enters the buffer, so a device whose true rate moves
 * further than the admission band allows stops appending entirely — and a
 * count-bounded buffer then freezes with the old regime in it, for good. The
 * profile is keyed by the CHARGER, so a 24 kWh car swapped for a 100 kWh one on
 * the same charger is exactly that: the honest rate moves by more than four
 * times and the history that locks it out can no longer be updated by the
 * evidence that would correct it. Ageing observations out is the only exit that
 * needs no new state — the buffer empties on its own, the band falls back to its
 * coarse bootstrap bound, and the next window is admitted and relearned from.
 *
 * The cost of that exit is bounded by this constant: worst case, a device whose
 * world changed plans from the old rate for two weeks before the last stale
 * observation ages out. Two weeks is also long enough that an ordinarily-active
 * device (a tank reheats daily) never runs short of in-horizon observations. A
 * device too idle to keep eight inside it simply reads as bootstrap, which is
 * the bound it had before any of this existed.
 */
export const OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
// Floor for any produced band — also gates `fitBandsFromSamples` on the whole
// buffer (must hold ≥2× this to even attempt a split). Prevents a freshly-split
// low-data band from dominating the estimate before it has enough evidence.
//
// SHS multi-band replay (2026-05-23, see
// `test/unit/objectiveProfileBandsShsReplay.test.ts`): a 6-sample buffer with a
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

// No forced band edge anywhere. A charging taper is real — kWh per unit worsens
// past the knee — but WHERE the knee sits varies car to car (chemistry, BMS,
// charger), so a fleet-wide anchor splits most cars in the wrong place and hands
// `greedyRefine` a partition whose every band straddles the real knee. The knee is
// learnt instead: `pickBestSplit` finds it from the samples, for whatever value
// this particular device tapers at, and finds nothing when the data does not
// support a split.

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
  // Anchored on the arriving observation, not on a wall clock: the buffer is a
  // record of windows, and "recent" for it means recent relative to the window
  // being recorded.
  const horizonStartMs = next.observedAtMs - OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS;
  const base = (previous ?? []).filter((sample) => sample.observedAtMs >= horizonStartMs);
  const overflow = base.length + 1 - OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE;
  if (overflow <= 0) return [...base, next];
  return [...base.slice(overflow), next];
}

/**
 * The device's global kWh/unit statistic, derived from the buffer rather than
 * accumulated alongside it.
 *
 * It used to be a running Welford pair updated once per accepted window, which
 * made it a SECOND record of the same history — and the one that could not be
 * corrected. Welford cannot have a contribution removed, so an observation that
 * aged out of the buffer stayed in the mean for the life of the profile, and
 * `resolveProfileEnergy` sizes every smart task from exactly that mean. A device
 * whose rate genuinely moved would have been let back into the buffer and STILL
 * planned at the old figure. Deriving the stat here means the buffer is the only
 * record, and the horizon reaches everything read off it.
 *
 * A profile written before the buffer existed carries a lifetime stat and no
 * observations; its first accepted window rebuilds the stat from that window
 * alone. That is the honest consequence of one truth rather than two, and it
 * self-heals within a handful of windows.
 */
export function resolveKwhPerUnitStat(
  samples: readonly ObjectiveProfileSampleObservation[],
  lastUpdatedMs: number,
): ObjectiveProfileStat | undefined {
  if (samples.length === 0) return undefined;
  const { sampleCount, mean, m2 } = welfordKwhPerUnit(samples, 0, samples.length);
  const rates = samples.map((sample) => sample.kwhPerUnit);
  return {
    sampleCount,
    mean,
    m2,
    min: Math.min(...rates),
    max: Math.max(...rates),
    confidence: resolveProfileConfidence({ sampleCount, mean, m2 }),
    lastUpdatedMs,
  };
}

export function fitBandsFromSamples(params: {
  samples: ObjectiveProfileSampleObservation[];
}): ObjectiveProfileBand[] | undefined {
  const { samples } = params;
  if (samples.length < OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2) return undefined;
  const sorted = [...samples].sort((left, right) => left.inputValue - right.inputValue);
  const initial = [buildBandFromSlice(sorted, 0, sorted.length)];
  return greedyRefine(sorted, initial);
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
  // The band being split, carried alongside its index so the applier reads the
  // bounds it was chosen from rather than re-indexing the array.
  band: ObjectiveProfileBand;
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
  for (const [bandIndex, band] of bands.entries()) {
    const range = sliceRangeForBand(sorted, band);
    if (range.end - range.start < OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2) continue;
    const candidate = bestSplitWithinRange(sorted, band, range, bandIndex);
    if (candidate && (!best || candidate.sseReduction > best.sseReduction)) {
      best = candidate;
    }
  }
  return best;
}

function bestSplitWithinRange(
  sorted: SortedSamples,
  band: ObjectiveProfileBand,
  range: { start: number; end: number },
  bandIndex: number,
): SplitCandidate | null {
  const parentSse = computeSse(sorted, range.start, range.end);
  const minReduction = parentSse * MIN_SSE_REDUCTION_FRACTION;
  let best: SplitCandidate | null = null;
  const firstSplit = range.start + OBJECTIVE_PROFILE_MIN_BAND_SAMPLES;
  const lastSplit = range.end - OBJECTIVE_PROFILE_MIN_BAND_SAMPLES;
  for (let splitIdx = firstSplit; splitIdx <= lastSplit; splitIdx += 1) {
    const splitSample = sorted[splitIdx];
    const previousSample = sorted[splitIdx - 1];
    // The split window sits strictly inside the range, so both reads are in
    // bounds; a range shorter than the window simply offers no split here.
    if (!splitSample || !previousSample) continue;
    // Cluster identical inputValues into the left side so the boundary lands
    // on a value not shared across sides.
    if (splitSample.inputValue === previousSample.inputValue) continue;
    const leftSse = computeSse(sorted, range.start, splitIdx);
    const rightSse = computeSse(sorted, splitIdx, range.end);
    const reduction = parentSse - (leftSse + rightSse);
    if (reduction <= minReduction) continue;
    if (!best || reduction > best.sseReduction) {
      best = {
        bandIndex,
        band,
        splitInputValue: splitSample.inputValue,
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
  const replaced = candidate.band;
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
  let index = 0;
  for (const band of bands) {
    if (index === candidate.bandIndex) {
      next.push(left);
      next.push(right);
    } else {
      next.push(band);
    }
    index += 1;
  }
  return next;
}


function sliceRangeForBand(
  sorted: SortedSamples,
  band: ObjectiveProfileBand,
): { start: number; end: number } {
  let start = -1;
  let end = sorted.length;
  for (const [i, sample] of sorted.entries()) {
    const v = sample.inputValue;
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
  const first = sorted[startIdx];
  const last = sorted[endIdx - 1];
  // Every caller passes a non-empty in-bounds slice; an empty one has no bounds
  // to report, and inventing them would fabricate a band out of no samples.
  if (!first || !last) {
    throw new RangeError(`band slice [${startIdx}, ${endIdx}) is empty or out of bounds`);
  }
  const lowerInclusive = first.inputValue;
  const upperExclusive = last.inputValue + BAND_UPPER_BOUND_EPSILON;
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
    const sample = sorted[i];
    // Callers pass in-bounds slices; a short one just ends the accumulation.
    if (!sample) break;
    const value = sample.kwhPerUnit;
    const n = i - startIdx + 1;
    const delta = value - mean;
    mean += delta / n;
    m2 += delta * (value - mean);
  }
  return { sampleCount, mean, m2 };
}
