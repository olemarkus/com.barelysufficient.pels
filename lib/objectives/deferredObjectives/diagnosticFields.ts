import { taskPermissionsForObjective } from './taskEvaluationProducer';
import { inactiveTaskEvaluation } from './taskEvaluation';
import type { PowerTrackerState } from '../../power/tracker';
import {
  resolveProfileEnergy,
  type DeferredObjectiveEnergyResolution,
  type DeferredObjectiveKwhPerUnitSource,
} from './profileEnergyResolution';
import {
  resolveObjectiveProgressDirectionRead,
  type ObjectiveDeviceInput,
} from '../../objectives/types';
import { formatDeadlineLocalTime } from './deadline';
import { resolvePlanningSpeedKw } from './planningSpeed';
import { resolveReachableTargetValue, type DeferredObjectiveProgressResolution } from './diagnosticProgress';
import type { DeferredObjectiveKind } from './types';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { resolveObjectiveTargetValue } from '../../../packages/shared-domain/src/deferredObjectiveValues';
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

type ResolvedProgress = Extract<DeferredObjectiveProgressResolution, { reasonCode: null }>;
export type ObjectiveProfileProgress =
  | { kind: 'level'; value: number }
  | { kind: 'exact_energy'; value: number }
  | { kind: 'unavailable'; reasonCode: Exclude<DeferredObjectiveProgressResolution['reasonCode'], null> };

type ProgressCurrentValueParams = {
  progress: DeferredObjectiveProgressResolution;
  objectiveKind: DeferredObjectiveKind;
};

// An energy task has exact metered progress, not a missing level. Unavailable
// observations carry their owner's reason instead of falling into a rate fallback.
export function progressCurrentValue(
  params: ProgressCurrentValueParams & { progress: ResolvedProgress },
): Exclude<ObjectiveProfileProgress, { kind: 'unavailable' }>;
export function progressCurrentValue(params: ProgressCurrentValueParams): ObjectiveProfileProgress;
export function progressCurrentValue(params: ProgressCurrentValueParams): ObjectiveProfileProgress {
  const { progress, objectiveKind } = params;
  if (progress.reasonCode !== null) return { kind: 'unavailable', reasonCode: progress.reasonCode };
  return { kind: objectiveKind === 'energy' ? 'exact_energy' : 'level', value: progress.currentValue };
}

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
  progress: ResolvedProgress;
}): DeferredObjectiveEnergyResolution => {
  const input = progressCurrentValue({ progress: params.progress, objectiveKind: params.objective.kind });
  return resolveProfileEnergy({
    powerTracker: params.powerTracker,
    deviceId: params.deviceId,
    objectiveKind: params.objective.kind,
    enforcement: params.objective.enforcement,
    remainingUnits: params.remainingUnits,
    progressDirection: params.progress.progressDirection,
    ...(input.kind === 'level' ? { currentValue: input.value } : {}),
  });
};

// Variant-preserving merge of the progress reading onto an existing diagnostic.
// The reading is in the task's own unit; the diagnostic's own `objectiveKind`
// says which column holds it besides the unit-agnostic `currentValue`. The
// discriminated union forbids `currentTemperatureC` on the other variants.
export const mergeProgressFields = (
  base: DeferredObjectiveDiagnostic,
  currentValue: number | null,
): DeferredObjectiveDiagnostic => {
  if (base.objectiveKind === 'temperature') {
    return { ...base, currentPercent: null, currentTemperatureC: currentValue, currentValue };
  }
  if (base.objectiveKind === 'energy') return { ...base, currentPercent: null, currentValue };
  return { ...base, currentPercent: currentValue, currentValue };
};

// The progress fields of a diagnostic that has not resolved its objective's
// progress (yet): the trajectory builders fill them in once it has.
export const UNRESOLVED_PROGRESS = {
  currentValue: null,
  energyNeededKWh: null,
  kWhPerUnitBanded: null,
  rateConfidence: null,
  displayConfidence: null,
  kwhPerUnitSource: null,
} as const;

export const buildDiagnosticBase = (params: {
  deviceId: string;
  // `undefined` when the device is missing from this tick's roster.
  device: ObjectiveDeviceInput | undefined;
  objective: DeferredObjectiveSettingsEntry;
  timeZone: string;
  powerTracker: PowerTrackerState;
  // The reading in the task's own unit; the variant places it.
  currentValue: number | null;
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
    evaluation: { ...inactiveTaskEvaluation(params.deviceId, params.objective.deadlineAtMs,
      resolveObjectiveTargetValue(params.objective)),
      permissions: taskPermissionsForObjective(params.objective) },
    progressDirection: resolveObjectiveProgressDirectionRead({
      objectiveKind: params.objective.kind,
      thermalDirection: params.device?.thermalDirection ?? 'unknown',
    }),
    deviceName: params.device?.name,
    objectiveId: `${params.deviceId}:${params.objective.kind}`,
    enforcement: params.objective.enforcement,
    ...(params.objective.rescue ? { rescue: params.objective.rescue } : {}),
    trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' },
    reasonCode: 'objective_progress_stale',
    actuationSatisfied: false,
    completion: { kind: 'inactive' },
    targetPercent: params.objective.kind === 'ev_soc' ? params.objective.targetPercent : null,
    currentPercent: params.objective.kind === 'ev_soc' ? params.currentValue : null,
    // Unit-agnostic pair, in the task's own unit for every kind.
    currentValue: params.currentValue,
    targetValue: resolveObjectiveTargetValue(params.objective),
    reachableTargetValue: resolveReachableTargetValue(params.objective, params.device),
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
    currentDrawKw: params.device === undefined ? null : params.device.currentDrawKw,
    horizonBucketCount: 0,
    expectedStepId: null,
  };
  if (params.objective.kind === 'temperature') {
    return {
      ...common,
      objectiveKind: 'temperature',
      targetTemperatureC: params.objective.targetTemperatureC,
      currentTemperatureC: params.currentValue,
    };
  }
  if (params.objective.kind === 'energy') {
    return {
      ...common,
      objectiveKind: 'energy',
      targetEnergyKWh: params.objective.targetEnergyKWh,
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
  if (!profile) {
    return { acceptedSamples: 0, lastAcceptedAtMs: null };
  }
  const lastAcceptedAtMs = profile.kwhPerUnit?.lastUpdatedMs ?? null;
  return {
    acceptedSamples: profile.acceptedSamples,
    lastAcceptedAtMs: Number.isFinite(lastAcceptedAtMs) ? lastAcceptedAtMs : null,
  };
};

/**
 * "No trajectory could be computed, and here is why."
 *
 * Named for what it produces rather than for the sentinel it used to stamp: the
 * result carries no verdict at all, so a consumer cannot read a data problem as
 * `on_track`.
 */
export const withUnavailableTrajectory = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: DeferredObjectiveDiagnosticReasonCode,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  trajectory: { kind: 'unavailable', reasonCode },
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
