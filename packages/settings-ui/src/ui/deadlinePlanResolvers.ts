import type {
  DeferredObjectiveEnergySettingsEntry,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveUnit,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import { getSteppedLoadLowestActiveStep } from '../../../shared-domain/src/deviceControlProfiles.ts';
import type {
  ObjectiveProfileConfidence,
} from '../../../contracts/src/objectiveProfileTypes.ts';
import type { SettingsUiObjectiveProfile, SettingsUiPowerTracker } from '../../../contracts/src/powerTrackerTypes.ts';
import type {
  ObservedDeviceState,
  ObservedStateOfCharge,
  ObservedStateOfChargeProbe,
  SteppedLoadProfile,
  TemperatureObservedProbe,
} from '../../../contracts/src/types.ts';
import { hasObservedTemperature } from '../../../shared-domain/src/temperatureObservedState.ts';
import { hasObservedStateOfCharge } from '../../../shared-domain/src/stateOfChargeObservedState.ts';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanSpeedMode,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { resolveChipConfidence, resolveSmartTaskLearning } from '../../../shared-domain/src/deadlineLabels.ts';
import { resolveRemainingEnergyKWh } from '../../../shared-domain/src/energyQuantities.ts';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../shared-domain/src/objectiveProfileBootstrap.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';


// The planner commits to running this device at the lowest non-zero step for
// the full hour (see `resolveAllocation` in `lib/objectives/deferredObjectives/
// horizonPlanner.ts`). The Plan inputs card surfaces that committed power so
// the user can sanity-check "Needs X kWh" against the realistic per-hour cap.
// Probe-widened onto the observed base rather than typed as the whole decorated
// snapshot: this reads a stepped profile and a planning power, nothing else, and
// declaring the full descriptor only type-checked for as long as every one of its
// fields stayed optional.
type LowestActiveStepInput = ObservedDeviceState & {
  steppedLoadProfile?: SteppedLoadProfile;
  planningPowerKw?: number;
};

export const resolveLowestActiveStepKw = (device: LowestActiveStepInput): number | null => {
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

export type DeadlineProgress = {
  currentValue: number;
  progressDirection: 'increasing' | 'decreasing';
  remainingUnits: number;
  targetValue: number;
  unit: DeferredObjectiveUnit;
};

/**
 * The percentage a present SoC bag stands behind, or `null` when it stands behind
 * none. The raw report never reaches here: `/ui_devices` serves the level alone,
 * so there is no carry-forward percentage to mistake for the device's charge.
 */
const observedStateOfChargePercent = (
  stateOfCharge: ObservedStateOfCharge,
): number | null => (
  stateOfCharge.level.kind === 'known' ? stateOfCharge.level.percent : null
);

// Progress comes from the device's live reading and nothing else, which is also
// the only thing the runtime reads (`resolveObjectiveProgress`). With no reading
// the runtime reports the task blocked (`objective_missing_temperature` /
// `objective_progress_stale`), so the page shows `no_current_reading`. The learned
// profile's last sample is not a stand-in: it is an older reading of the same
// absent thing, and drawing a trajectory from it put the page on track for a task
// the runtime had stopped.
export const resolveProgress = (
  // Probe-widened: the live reading (temperature or SoC) rides on the
  // `/ui_devices` snapshot the base type omits; `hasObservedTemperature` /
  // `hasObservedStateOfCharge` narrow it (present implies finite). Widened onto
  // the observed base, not the decorated snapshot: no descriptor field is read
  // here. SoC is the RESOLVED probe — the payload serves the level, so declaring
  // the transport's bag would let a `report.percent` read compile and then find
  // `undefined` at runtime.
  device: ObservedDeviceState & TemperatureObservedProbe & ObservedStateOfChargeProbe,
  // An energy task reads no device reading: `resolveEnergyProgress`.
  objective: Exclude<DeferredObjectiveSettingsEntry, DeferredObjectiveEnergySettingsEntry>,
  progressDirection: 'increasing' | 'decreasing' | 'unknown',
): DeadlineProgress | null => {
  if (objective.kind === 'temperature') {
    if (!hasObservedTemperature(device) || progressDirection === 'unknown') return null;
    return buildTemperatureProgress(
      device.temperature.currentTemperature,
      objective.targetTemperatureC,
      progressDirection,
    );
  }

  // `level`, never the raw report. `hasObservedStateOfCharge` proves only that the
  // bag exists, so reading the raw percentage rendered a departed car's charge as
  // "now" for a charger whose level had gone to `not_connected`.
  //
  // The trailing `isFiniteNumber` covers the `null` of a bag with no known level,
  // and keeps a junk percentage off the page (see the regression lock in
  // `deadlinePlan.test.ts`).
  if (!hasObservedStateOfCharge(device)) return null;
  const percent = observedStateOfChargePercent(device.stateOfCharge);
  if (!isFiniteNumber(percent)) return null;
  return {
    currentValue: Math.min(100, Math.max(0, percent)),
    progressDirection: 'increasing',
    remainingUnits: Math.max(0, objective.targetPercent - percent),
    targetValue: objective.targetPercent,
    unit: '%',
  };
};

/**
 * An energy task's progress: the energy fed since it started, which an energy
 * plan carries (the runtime's delivery count, the same count the runtime plans
 * from). The device has no reading this task is measured by, so a plan still
 * standing from the device's previous task of another kind has no progress to
 * show for this one.
 */
export const resolveEnergyProgress = (
  objective: DeferredObjectiveEnergySettingsEntry,
  activePlan: ResolvedDeferredObjectiveActivePlanV1,
): DeadlineProgress | null => {
  if (activePlan.objectiveKind !== 'energy') return null;
  const delivered = activePlan.deliveredKWh;
  return {
    currentValue: delivered,
    progressDirection: 'increasing',
    remainingUnits: Math.max(0, objective.targetEnergyKWh - delivered),
    targetValue: objective.targetEnergyKWh,
    unit: 'kWh',
  };
};

/**
 * A task's progress for the page: an energy task's rides on its plan (the
 * energy delivered so far); every other kind reads its level off the device.
 */
export const resolveTaskProgress = (
  device: ObservedDeviceState & TemperatureObservedProbe & ObservedStateOfChargeProbe,
  objective: DeferredObjectiveSettingsEntry,
  activePlan: ResolvedDeferredObjectiveActivePlanV1,
): DeadlineProgress | null => (
  objective.kind === 'energy'
    ? resolveEnergyProgress(objective, activePlan)
    : resolveProgress(device, objective, activePlan.progressDirection)
);

function buildTemperatureProgress(
  currentTemperature: number,
  targetTemperature: number,
  progressDirection: 'increasing' | 'decreasing',
): DeadlineProgress {
  const delta = progressDirection === 'increasing'
    ? targetTemperature - currentTemperature
    : currentTemperature - targetTemperature;
  return {
    currentValue: currentTemperature,
    progressDirection,
    remainingUnits: Math.max(0, delta),
    targetValue: targetTemperature,
    unit: '°C',
  };
}

export const resolveProfile = (
  powerTracker: SettingsUiPowerTracker | null,
  deviceId: string,
): SettingsUiObjectiveProfile | null => (
  powerTracker?.objectiveProfiles?.[deviceId] ?? null
);

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
  profile: SettingsUiObjectiveProfile | null;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
}): { rateMean: number | null; usingBootstrap: boolean; speedMode: DeferredObjectiveActivePlanSpeedMode } => {
  const speedMode: DeferredObjectiveActivePlanSpeedMode = params.latest.speedMode
    ?? (params.latest.kwhPerUnitSource === 'bootstrap' ? 'learning' : 'auto');
  const usingBootstrap = speedMode === 'learning';
  if (params.latest.rateMean !== undefined) {
    return { rateMean: params.latest.rateMean, usingBootstrap, speedMode };
  }
  // An energy task's rate is exact (one kWh per kWh), so the recorder stores no
  // rate and there is no per-unit rate row to show; a profile the device may
  // have learned for another kind says nothing about it.
  if (params.objectiveKind === 'energy') return { rateMean: null, usingBootstrap, speedMode };
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
  profile: SettingsUiObjectiveProfile | null;
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
  // Absence encodes equality with `energyNeededKWh` (steady device, cold-start,
  // or a plan persisted before the variance buffer shipped). Routed through the
  // one shared resolver so this rule has a single home — it was previously
  // spelled out independently here, in the widget payload, and in the
  // attribution producer, and the attribution copy got it wrong.
  //
  // A null answer means "no usable energy figure", which is the same verdict
  // the `revisionEnergy` guard above returns for. Answering it the same way
  // rather than substituting `revisionEnergy` keeps this a read of the
  // resolver's result instead of a kept fallback derivation (root `AGENTS.md`).
  const energyExpectedKWh = resolveRemainingEnergyKWh({
    energyExpectedKWh: params.activePlan.latest?.energyExpectedKWh,
    energyNeededKWh: revisionEnergy,
  });
  if (energyExpectedKWh === null) return null;
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
