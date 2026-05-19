import type { PowerTrackerState } from '../../core/powerTracker';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../packages/shared-domain/src/objectiveProfileBootstrap';
import type {
  DeviceObjectiveProfile,
  ObjectiveProfileBand,
  ObjectiveProfileConfidence,
  ObjectiveProfileStat,
} from '../../core/objectiveProfileTypes';
import type { DeferredObjectiveKind } from './types';

export type DeferredObjectiveKwhPerUnitSource = 'learned' | 'bootstrap';

export type DeferredObjectiveEnergyResolution = {
  energyNeededKWh: number;
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

export const resolveProfileEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objectiveKind: DeferredObjectiveKind;
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
    });
  }
  // Bootstrap fallback for EV SoC objectives: SoC reporting depends on a
  // plugged-in charge session, so a learned `kwhPerUnit` often isn't available
  // when the user first sets a deadline. Use a conservative-high default so
  // the planner can produce a useful allocation immediately; the very next
  // accepted profile sample takes over and an automatic `rate_refined`
  // revision is written when the allocation shifts.
  if (params.objectiveKind === 'ev_soc') {
    return {
      energyNeededKWh: params.remainingUnits * BOOTSTRAP_EV_SOC_KWH_PER_PERCENT,
      kWhPerUnit: BOOTSTRAP_EV_SOC_KWH_PER_PERCENT,
      rateConfidence: null,
      displayConfidence: null,
      kwhPerUnitSource: 'bootstrap',
      reasonCode: null,
    };
  }
  return {
    energyNeededKWh: null,
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
}): DeferredObjectiveEnergyResolution => {
  const { profile, kWhPerUnit, remainingUnits, currentValue } = params;
  const globalMean = kWhPerUnit.mean;
  const banded = integrateBands({
    bands: profile?.bands,
    globalMean,
    remainingUnits,
    currentValue,
  });
  const energyNeededKWh = banded?.energyNeededKWh ?? remainingUnits * globalMean;
  // Effective kWh/unit reported to the planner is the integrated total divided
  // by remainingUnits; for the unbanded fallback this collapses to globalMean.
  const effectiveKwhPerUnit = remainingUnits > 0 ? energyNeededKWh / remainingUnits : globalMean;
  return {
    energyNeededKWh,
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
  remainingUnits: number;
  currentValue: number | undefined;
}): { energyNeededKWh: number } | null => {
  const { bands, globalMean, remainingUnits, currentValue } = params;
  if (!bands || bands.length === 0) return null;
  if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) return null;
  if (remainingUnits <= 0) return { energyNeededKWh: 0 };
  const targetValue = currentValue + remainingUnits;
  let energy = 0;
  let coveredUnits = 0;
  for (const band of bands) {
    const overlap = computeOverlap(band, currentValue, targetValue);
    if (overlap <= 0) continue;
    const bandMean = band.sampleCount >= MIN_BAND_SAMPLES_FOR_INTEGRATION ? band.mean : globalMean;
    energy += overlap * bandMean;
    coveredUnits += overlap;
  }
  // Bands may not cover the entire [current, target] interval — anything
  // outside the observed range (e.g., target above the highest band edge or
  // current below the lowest) gets the global mean.
  const uncoveredUnits = Math.max(0, remainingUnits - coveredUnits);
  energy += uncoveredUnits * globalMean;
  return { energyNeededKWh: energy };
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
