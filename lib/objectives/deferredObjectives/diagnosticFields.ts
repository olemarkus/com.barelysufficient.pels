import { taskPermissionsForObjective } from './taskEvaluationProducer';
import { inactiveTaskEvaluation } from './taskEvaluation';
import type { PowerTrackerState } from '../../power/tracker';
import {
  resolveProfileEnergy,
  type DeferredObjectiveEnergyResolution,
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
export const resolveProgressEnergy = (
  powerTracker: PowerTrackerState,
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry,
  remainingUnits: number,
  progress: ResolvedProgress,
): DeferredObjectiveEnergyResolution => {
  const input = progressCurrentValue({ progress, objectiveKind: objective.kind });
  return resolveProfileEnergy(
    powerTracker,
    deviceId,
    objective.kind,
    objective.enforcement,
    remainingUnits,
    progress.progressDirection,
    input.kind === 'level' ? input.value : undefined,
  );
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

// The diagnostic of a task whose progress is not resolved (yet): its progress
// fields are empty, and the trajectory builders fill them in once it is.
export const buildDiagnosticBase = (
  deviceId: string,
  // `undefined` when the device is missing from this tick's roster.
  device: ObjectiveDeviceInput | undefined,
  objective: DeferredObjectiveSettingsEntry,
  timeZone: string,
  powerTracker: PowerTrackerState,
): DeferredObjectiveDiagnostic => {
  const deadlineAtMs = Number.isFinite(objective.deadlineAtMs) && objective.deadlineAtMs > 0
    ? objective.deadlineAtMs
    : null;
  const profileSnapshot = resolveProfileSnapshot(powerTracker, deviceId);
  const common: BaseDeferredObjectiveDiagnostic = {
    deviceId: deviceId,
    evaluation: { ...inactiveTaskEvaluation(deviceId, objective.deadlineAtMs,
      resolveObjectiveTargetValue(objective)),
      permissions: taskPermissionsForObjective(objective) },
    progressDirection: resolveObjectiveProgressDirectionRead({
      objectiveKind: objective.kind,
      thermalDirection: device?.thermalDirection ?? 'unknown',
    }),
    deviceName: device?.name,
    objectiveId: `${deviceId}:${objective.kind}`,
    enforcement: objective.enforcement,
    ...(objective.rescue ? { rescue: objective.rescue } : {}),
    trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' },
    reasonCode: 'objective_progress_stale',
    completion: { kind: 'inactive' },
    targetPercent: objective.kind === 'ev_soc' ? objective.targetPercent : null,
    currentPercent: null,
    // Unit-agnostic pair, in the task's own unit for every kind.
    currentValue: null,
    targetValue: resolveObjectiveTargetValue(objective),
    reachableTargetValue: resolveReachableTargetValue(objective, device),
    deadlineAtMs,
    deadlineLocalTime: deadlineAtMs !== null ? formatDeadlineLocalTime(deadlineAtMs, timeZone) : '',
    energyNeededKWh: null,
    kWhPerUnitBanded: null,
    // Base default; resolved diagnostics override via `buildKnownEnergyFields`.
    kwhPerUnitLearnedMean: null,
    rateConfidence: null,
    displayConfidence: null,
    kwhPerUnitSource: null,
    kwhPerUnitAcceptedSamples: profileSnapshot.acceptedSamples,
    kwhPerUnitLastAcceptedAtMs: profileSnapshot.lastAcceptedAtMs,
    planningSpeedKw: resolvePlanningSpeedKw(device),
    currentDrawKw: device === undefined ? null : device.currentDrawKw,
    horizonBucketCount: 0,
    expectedStepId: null,
  };
  if (objective.kind === 'temperature') {
    return {
      ...common,
      objectiveKind: 'temperature',
      targetTemperatureC: objective.targetTemperatureC,
      currentTemperatureC: null,
    };
  }
  if (objective.kind === 'energy') {
    return {
      ...common,
      objectiveKind: 'energy',
      targetEnergyKWh: objective.targetEnergyKWh,
    };
  }
  return {
    ...common,
    objectiveKind: 'ev_soc',
  };
};

// Pulls accepted-sample provenance from the active learned profile. Returns
// zeros / nulls when the device has no profile so legacy callers see safe
// defaults.
const resolveProfileSnapshot = (
  powerTracker: PowerTrackerState,
  deviceId: string,
): { acceptedSamples: number; lastAcceptedAtMs: number | null } => {
  const profile = powerTracker.objectiveProfiles?.[deviceId];
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
