import type { PowerTrackerState } from '../../power/tracker';
import {
  resolveProfileEnergy,
  type DeferredObjectiveEnergyResolution,
  type DeferredObjectiveKwhPerUnitSource,
} from './profileEnergyResolution';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { formatDeadlineLocalTime } from './deadline';
import { resolvePlanningSpeedKw } from './planningSpeed';
import type { DeferredObjectiveProgressResolution } from './diagnosticProgress';
import type { DeferredObjectiveKind, DeferredObjectiveHorizonPlan } from './types';
import type { DeferredObjectiveSettingsEntry } from './settings';
import type {
  BaseDeferredObjectiveDiagnostic,
  DeferredObjectiveDiagnostic,
  DeferredObjectiveDiagnosticReasonCode,
} from './diagnosticTypes';

// Energy resolution for an already-satisfied objective (`remainingUnits <= 0`):
// no energy needed, no rate consulted.
export const ZERO_ENERGY_RESOLUTION: DeferredObjectiveEnergyResolution = {
  energyNeededKWh: 0,
  energyExpectedKWh: 0,
  kWhPerUnit: null,
  kWhPerUnitBuffered: null,
  kWhPerUnitMean: null,
  rateConfidence: null,
  displayConfidence: null,
  kwhPerUnitSource: null,
  reasonCode: null,
};

// Maps the progress resolution back to a single input-value for the banded
// estimator. Temperature objectives integrate by °C, EV SoC objectives by %.
// `generic_energy` has no profile-band path so we return undefined and the
// estimator falls back to the global mean.
export const progressCurrentValue = (params: {
  progress: DeferredObjectiveProgressResolution;
  objectiveKind: DeferredObjectiveKind;
}): number | undefined => {
  const { progress, objectiveKind } = params;
  if (progress.reasonCode) return undefined;
  if (objectiveKind === 'ev_soc') {
    return typeof progress.currentPercent === 'number' ? progress.currentPercent : undefined;
  }
  if (objectiveKind === 'temperature') {
    return typeof progress.currentTemperatureC === 'number' ? progress.currentTemperatureC : undefined;
  }
  return undefined;
};

export const canReportFreshProgressWhileUnknown = (
  reasonCode: DeferredObjectiveDiagnosticReasonCode,
): boolean => (
  reasonCode === 'objective_missing_price_horizon'
    || reasonCode === 'objective_price_feature_disabled'
);

// Single entry point for resolving learned/buffered energy from progress, so
// both diagnostic paths pass the objective's enforcement (which sets the
// variance buffer `k`) and current value identically.
export const resolveProgressEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  remainingUnits: number;
  progress: DeferredObjectiveProgressResolution;
}): DeferredObjectiveEnergyResolution => resolveProfileEnergy({
  powerTracker: params.powerTracker,
  deviceId: params.deviceId,
  objectiveKind: params.objective.kind,
  enforcement: params.objective.enforcement,
  remainingUnits: params.remainingUnits,
  currentValue: progressCurrentValue({ progress: params.progress, objectiveKind: params.objective.kind }),
});

// Variant-preserving merge of progress-derived fields onto an existing
// diagnostic. The discriminated union forbids assigning
// `currentTemperatureC` on the EV variant, so we branch on the diagnostic's
// own `objectiveKind` rather than spreading both fields blindly.
export const mergeProgressFields = (
  base: DeferredObjectiveDiagnostic,
  currentPercent: number | null,
  currentTemperatureC: number | null,
): DeferredObjectiveDiagnostic => {
  if (base.objectiveKind === 'temperature') {
    return { ...base, currentPercent, currentTemperatureC, currentValue: currentTemperatureC };
  }
  return { ...base, currentPercent, currentValue: currentPercent };
};

// "Is the current bucket actually running this cycle?" — gates the
// `budgetExemptApplied` diagnostic. A price-deferral-eligible OR cold-start-released
// hour is released (admission idles the device), so the budget exemption is NOT
// active even though the committed bucket still carries booked energy; report it
// false so the structured log matches what the device is actually doing. Mirrors
// admission's `isReleasedCurrentHour` for the booked-but-released cases.
export const isCurrentBucketPlanned = (horizonPlan: DeferredObjectiveHorizonPlan): boolean => (
  !horizonPlan.priceDeferralEligible
  && !horizonPlan.coldStartReleaseEligible
  && (horizonPlan.currentBucket?.plannedUsefulEnergyKWh ?? 0) > 0
);

export const buildDiagnosticBase = (params: {
  deviceId: string;
  device?: ObjectiveDeviceInput;
  objective: DeferredObjectiveSettingsEntry;
  timeZone: string;
  powerTracker: PowerTrackerState;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  energyNeededKWh: number | null;
  kWhPerUnitBanded: number | null;
  rateConfidence: string | null;
  displayConfidence: 'low' | 'medium' | 'high' | null;
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
}): DeferredObjectiveDiagnostic => {
  const deadlineAtMs = Number.isFinite(params.objective.deadlineAtMs) && params.objective.deadlineAtMs > 0
    ? params.objective.deadlineAtMs
    : null;
  const profileSnapshot = resolveProfileSnapshot({
    powerTracker: params.powerTracker,
    deviceId: params.deviceId,
    objectiveKind: params.objective.kind,
  });
  const common: BaseDeferredObjectiveDiagnostic = {
    deviceId: params.deviceId,
    deviceName: params.device?.name,
    objectiveId: `${params.deviceId}:${params.objective.kind}`,
    enforcement: params.objective.enforcement,
    ...(params.objective.rescue ? { rescue: params.objective.rescue } : {}),
    status: 'unknown',
    reasonCode: 'objective_progress_stale',
    targetPercent: params.objective.kind === 'ev_soc' ? params.objective.targetPercent : null,
    currentPercent: params.currentPercent,
    // Unit-agnostic pair. Seeded for the ev_soc shape here; the temperature
    // variant below overrides both with the °C readings so the invariant holds.
    currentValue: params.currentPercent,
    targetValue: params.objective.kind === 'ev_soc' ? params.objective.targetPercent : null,
    deadlineAtMs,
    deadlineLocalTime: deadlineAtMs !== null ? formatDeadlineLocalTime(deadlineAtMs, params.timeZone) : '',
    energyNeededKWh: params.energyNeededKWh,
    kWhPerUnitBanded: params.kWhPerUnitBanded,
    // Base default; resolved diagnostics override via `buildKnownEnergyFields`.
    kwhPerUnitLearnedMean: null,
    rateConfidence: params.rateConfidence,
    displayConfidence: params.displayConfidence,
    kwhPerUnitSource: params.kwhPerUnitSource,
    kwhPerUnitAcceptedSamples: profileSnapshot.acceptedSamples,
    kwhPerUnitLastAcceptedAtMs: profileSnapshot.lastAcceptedAtMs,
    planningSpeedKw: resolvePlanningSpeedKw(params.device),
    horizonBucketCount: 0,
    dailyBudgetExhaustedBucketCount: 0,
    expectedStepId: null,
  };
  if (params.objective.kind === 'temperature') {
    return {
      ...common,
      objectiveKind: 'temperature',
      targetTemperatureC: params.objective.targetTemperatureC,
      currentTemperatureC: params.currentTemperatureC,
      // Override the ev_soc-shaped seed: temperature reads in °C.
      currentValue: params.currentTemperatureC,
      targetValue: params.objective.targetTemperatureC,
    };
  }
  return {
    ...common,
    objectiveKind: 'ev_soc',
  };
};

// Pulls accepted-sample provenance from the active learned profile. Returns
// zeros / nulls when no profile or the profile's kind doesn't match the
// objective so legacy callers see safe defaults.
const resolveProfileSnapshot = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
}): { acceptedSamples: number; lastAcceptedAtMs: number | null } => {
  const profile = params.powerTracker.objectiveProfiles?.[params.deviceId];
  if (!profile || profile.kind !== params.objectiveKind) {
    return { acceptedSamples: 0, lastAcceptedAtMs: null };
  }
  const lastAcceptedAtMs = profile.kwhPerUnit?.lastUpdatedMs ?? null;
  return {
    acceptedSamples: profile.acceptedSamples,
    lastAcceptedAtMs: Number.isFinite(lastAcceptedAtMs) ? lastAcceptedAtMs : null,
  };
};

export const withUnknown = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: DeferredObjectiveDiagnosticReasonCode,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  status: 'unknown',
  reasonCode,
  expectedStepId: null,
});

export const buildKnownEnergyFields = (params: {
  objective: DeferredObjectiveSettingsEntry;
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>;
}): Pick<
  DeferredObjectiveDiagnostic,
  'energyNeededKWh' | 'energyExpectedKWh' | 'kWhPerUnitBanded'
  | 'kWhPerUnitBuffered' | 'kwhPerUnitLearnedMean' | 'rateConfidence' | 'displayConfidence' | 'kwhPerUnitSource'
> => ({
  energyNeededKWh: params.profileEnergy.energyNeededKWh,
  energyExpectedKWh: params.profileEnergy.energyExpectedKWh,
  kWhPerUnitBanded: params.profileEnergy.kWhPerUnit,
  kWhPerUnitBuffered: params.profileEnergy.kWhPerUnitBuffered,
  kwhPerUnitLearnedMean: params.profileEnergy.kWhPerUnitMean,
  rateConfidence: params.profileEnergy.rateConfidence,
  displayConfidence: params.profileEnergy.displayConfidence,
  kwhPerUnitSource: params.profileEnergy.kwhPerUnitSource,
});
