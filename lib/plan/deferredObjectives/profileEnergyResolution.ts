import type { PowerTrackerState } from '../../core/powerTracker';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../packages/shared-domain/src/objectiveProfileBootstrap';
import type {
  DeviceObjectiveProfile,
  ObjectiveProfileBand,
  ObjectiveProfileStat,
} from '../../core/objectiveProfileTypes';
import type { DeferredObjectiveKind } from './types';

export type DeferredObjectiveKwhPerUnitSource = 'learned' | 'bootstrap';

export type DeferredObjectiveEnergyResolution = {
  energyNeededKWh: number;
  kWhPerUnit: number | null;
  rateConfidence: string | null;
  // null when the resolution did not consult a profile, e.g. when the target
  // is already satisfied and we short-circuit `energyNeededKWh` to zero.
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
  reasonCode: null;
} | {
  energyNeededKWh: null;
  kWhPerUnit: null;
  rateConfidence: null;
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
      kwhPerUnitSource: 'bootstrap',
      reasonCode: null,
    };
  }
  return {
    energyNeededKWh: null,
    kWhPerUnit: null,
    rateConfidence: null,
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
    kwhPerUnitSource: 'learned',
    reasonCode: null,
  };
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
