import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { getSteppedLoadLowestActiveStep } from '../../../contracts/src/deviceControlProfiles.ts';
import type {
  DeviceObjectiveProfile,
  ObjectiveProfileConfidence,
} from '../../../contracts/src/objectiveProfileTypes.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import type { DecoratedDeviceSnapshot } from '../../../contracts/src/types.ts';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanSpeedMode,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { resolveChipConfidence, resolveSmartTaskLearning } from '../../../shared-domain/src/deadlineLabels.ts';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../shared-domain/src/objectiveProfileBootstrap.ts';
import { isFiniteNumber } from './deadlinePlanData.ts';


// The planner commits to running this device at the lowest non-zero step for
// the full hour (see `resolveAllocation` in `lib/objectives/deferredObjectives/
// horizonPlanner.ts`). The Plan inputs card surfaces that committed power so
// the user can sanity-check "Needs X kWh" against the realistic per-hour cap.
export const resolveLowestActiveStepKw = (device: DecoratedDeviceSnapshot): number | null => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
    if (lowestActiveStep && isFiniteNumber(lowestActiveStep.planningPowerW) && lowestActiveStep.planningPowerW > 0) {
      return lowestActiveStep.planningPowerW / 1000;
    }
  }
  return isFiniteNumber(device.planningPowerKw) && device.planningPowerKw > 0
    ? device.planningPowerKw
    : null;
};

const resolveProfileSampleValue = (
  profile: DeviceObjectiveProfile | null,
  unit: DeviceObjectiveProfile['lastSample']['unit'],
): number | null => {
  if (!profile || profile.lastSample.unit !== unit) return null;
  return isFiniteNumber(profile.lastSample.value) ? profile.lastSample.value : null;
};

export type DeadlineProgress = {
  currentValue: number;
  remainingUnits: number;
  targetValue: number;
  unit: '°C' | '%';
};

export const resolveProgress = (params: {
  device: DecoratedDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  profile: DeviceObjectiveProfile | null;
}): DeadlineProgress | null => {
  const { device, objective, profile } = params;
  if (objective.kind === 'temperature') {
    const currentTemperature = isFiniteNumber(device.currentTemperature)
      ? device.currentTemperature
      : resolveProfileSampleValue(profile, 'degree_c');
    if (!isFiniteNumber(currentTemperature)) return null;
    const remainingUnits = Math.max(0, objective.targetTemperatureC - currentTemperature);
    return {
      currentValue: currentTemperature,
      remainingUnits,
      targetValue: objective.targetTemperatureC,
      unit: '°C',
    };
  }

  const percent = isFiniteNumber(device.stateOfCharge?.percent)
    ? device.stateOfCharge.percent
    : resolveProfileSampleValue(profile, 'percent');
  if (!isFiniteNumber(percent)) return null;
  return {
    currentValue: Math.min(100, Math.max(0, percent)),
    remainingUnits: Math.max(0, objective.targetPercent - percent),
    targetValue: objective.targetPercent,
    unit: '%',
  };
};

export const resolveProfile = (
  powerTracker: PowerTrackerState | null,
  deviceId: string,
  objectiveKind: DeferredObjectiveSettingsEntry['kind'],
): DeviceObjectiveProfile | null => {
  const profile = powerTracker?.objectiveProfiles?.[deviceId];
  return profile?.kind === objectiveKind ? profile : null;
};

// Reads the producer-resolved flat display fields (`rateMean` / `speedMode`)
// off the latest revision, with a back-compat fallback for legacy revisions
// persisted before the recorder shipped them. The fallback reproduces what the
// retired `resolveKwhPerUnitDisplayRate` / `resolveSpeedModeLabel` helpers did:
//   - `speedMode`: absent → derive from `kwhPerUnitSource` (bootstrap →
//     `learning`, else `auto`). Old revisions carry `kwhPerUnitSource`.
//   - `rateMean`: absent → bootstrap constant when the (derived) mode is
//     `learning` for an EV objective, else the live learned-profile mean.
// `usingBootstrap` (drives the "Estimated — refining…" note) equals
// `speedMode === 'learning'`: bootstrap source is EV-cold-start only.
export const resolveDisplayRateAndSpeedMode = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  profile: DeviceObjectiveProfile | null;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
}): { rateMean: number | null; usingBootstrap: boolean; speedMode: DeferredObjectiveActivePlanSpeedMode } => {
  const speedMode: DeferredObjectiveActivePlanSpeedMode = params.latest.speedMode
    ?? (params.latest.kwhPerUnitSource === 'bootstrap' ? 'learning' : 'auto');
  const usingBootstrap = speedMode === 'learning';
  if (params.latest.rateMean !== undefined) {
    return { rateMean: params.latest.rateMean, usingBootstrap, speedMode };
  }
  // Legacy revision without the flat rate: reconstruct it the way the old UI
  // resolver did, so pre-upgrade plans keep rendering the right rate until the
  // next replan re-records the producer field.
  if (usingBootstrap && params.objectiveKind === 'ev_soc') {
    return { rateMean: BOOTSTRAP_EV_SOC_KWH_PER_PERCENT, usingBootstrap, speedMode };
  }
  const learnedMean = params.profile?.kwhPerUnit?.mean;
  return {
    rateMean: typeof learnedMean === 'number' && Number.isFinite(learnedMean) ? learnedMean : null,
    usingBootstrap,
    speedMode,
  };
};

export const resolveEnergyNeededKWh = (params: {
  profile: DeviceObjectiveProfile | null;
  activePlan: ResolvedDeferredObjectiveActivePlanV1;
}): {
  energyNeededKWh: number;
  // Mean-based estimate paired with the buffered `energyNeededKWh` for the
  // `expected…planned` range. Equals `energyNeededKWh` (range collapses) when
  // the revision carries no separate expected figure (steady device, cold-start,
  // or a plan persisted before the variance buffer shipped).
  energyExpectedKWh: number;
  confidence: ObjectiveProfileConfidence | null;
  // True only during genuine cold-start; gates the "Estimating" chip.
  learning: boolean;
} | null => {
  // The recorder stores `energyNeededKWh` straight from the horizon planner —
  // authoritative even under `cannot_meet` (allocated hours can round to zero
  // for sub-second remaining buckets). The UI never needs its own learned
  // profile to render the timeline.
  const revisionEnergy = params.activePlan.latest?.energyNeededKWh;
  if (!isFiniteNumber(revisionEnergy) || revisionEnergy <= 0) return null;
  const revisionExpected = params.activePlan.latest?.energyExpectedKWh;
  const energyExpectedKWh = isFiniteNumber(revisionExpected) && revisionExpected > 0
    ? revisionExpected
    : revisionEnergy;
  // Producer-resolved per `feedback_layering_resolution_in_producer.md`: the
  // shared-domain helpers own the preference chain. The UI sees flat values
  // and never branches on provenance / source / kind.
  const confidence = resolveChipConfidence({
    provenance: params.activePlan.kwhPerUnitProvenance,
    profileConfidence: params.profile?.kwhPerUnit?.confidence ?? null,
  });
  const learning = resolveSmartTaskLearning(params.activePlan.kwhPerUnitProvenance);
  return { energyNeededKWh: revisionEnergy, energyExpectedKWh, confidence, learning };
};
