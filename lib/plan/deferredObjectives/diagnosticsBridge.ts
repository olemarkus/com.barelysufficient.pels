import type { PowerTrackerState } from '../../core/powerTracker';
import {
  resolveProfileEnergy,
  type DeferredObjectiveEnergyResolution,
  type DeferredObjectiveKwhPerUnitSource,
} from './profileEnergyResolution';
import { buildDeferredObjectiveDebugPayload } from './diagnosticDebugPayload';
import type { DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import type { PlanInputDevice } from '../planTypes';
import { formatDeadlineLocalTime } from './deadline';
import { planDeferredObjectiveHorizon } from './horizonPlanner';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { firstPositiveFinite, resolvePlanningSpeedKw } from './planningSpeed';
import {
  resolveObjectiveProgress,
  type DeferredObjectiveProgressResolution,
} from './diagnosticProgress';
import type { DeferredObjectiveKind } from './types';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePolicyHorizonUnavailableReason,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsV1 } from './settings';
import type {
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from './types';

// Reserve a flat 1-hour safety buffer before the deadline. The horizon planner
// allocates into the primary window (now → deadline − reserve) first and only
// dips into the reserve hour when every earlier hour is fully booked. Crossing
// into the reserve flips the diagnostic to `at_risk` so users see "your plan
// has no slack left" before they actually miss the deadline. A 1-hour reserve
// is the smallest buffer that gives users actionable warning time for the
// EV-overnight / heater-morning use cases this slice targets.
const DEFAULT_DEADLINE_RESERVE_MS = 60 * 60 * 1000;

export type DeferredObjectiveDiagnosticReasonCode =
  | DeferredObjectivePolicyHorizonUnavailableReason
  | 'objective_invalid_deadline'
  | 'objective_invalid_session'
  | 'objective_missing_capacity'
  | 'objective_missing_charge_rate'
  | 'objective_missing_device'
  | 'objective_missing_temperature'
  | 'objective_progress_stale';

export type { DeferredObjectiveKwhPerUnitSource } from './profileEnergyResolution';

export type DeferredObjectiveDiagnostic = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
  enforcement: DeferredObjectiveSettingsEntry['enforcement'];
  status: 'unknown' | DeferredObjectiveHorizonPlan['status'];
  reasonCode: DeferredObjectiveDiagnosticReasonCode | DeferredObjectiveHorizonPlan['statusDetail'];
  targetPercent: number | null;
  currentPercent: number | null;
  targetTemperatureC: number | null;
  currentTemperatureC: number | null;
  deadlineAtMs: number | null;
  deadlineLocalTime: string;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
  // Number of accepted samples that produced the learned profile mean. Zero
  // when `kwhPerUnitSource` is `bootstrap` or null. Surfaced so the UI can
  // explain EV learning progress without re-reading the profile store.
  kwhPerUnitAcceptedSamples: number;
  // UTC ms of the last accepted sample. Null when no learned profile exists
  // yet (bootstrap or unresolved).
  kwhPerUnitLastAcceptedAtMs: number | null;
  // The "useful" planning power in kW that the planner would commit per
  // active hour. For stepped devices this is the lowest non-zero step's
  // useful power; for binary devices (EV chargers) it is the single step's
  // useful power. Null when no steps were resolvable. Surfaced as the
  // "Y.Y kW" speed-mode reading in the hero meta line.
  planningSpeedKw: number | null;
  horizonBucketCount: number;
  // Number of buckets in the horizon whose per-bucket cap collapsed to zero
  // because the daily budget cap had already been reached at the start of the
  // bucket. Lets the UI explain a `cannot_meet` outcome that would otherwise
  // look like a device or schedule problem.
  dailyBudgetExhaustedBucketCount: number;
  requestedMinimumStepId: string | null;
  horizonPlan?: DeferredObjectiveHorizonPlan;
};

export const buildDeferredObjectiveDiagnostics = (params: {
  nowMs: number;
  timeZone: string;
  devices: PlanInputDevice[];
  settings: DeferredObjectiveSettingsV1;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
}): DeferredObjectiveDiagnostic[] => {
  const deviceById = new Map(params.devices.map((device) => [device.id, device]));
  return Object.entries(params.settings.objectivesByDeviceId)
    .flatMap(([deviceId, objective]) => {
      if (!objective.enabled) return [];
      return [buildDeferredObjectiveDiagnostic({
        ...params,
        deviceId,
        objective,
        device: deviceById.get(deviceId),
      })];
    });
};

export const emitDeferredObjectiveDiagnostics = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  debugStructured?: StructuredDebugEmitter;
}): void => {
  const { diagnostics, debugStructured } = params;
  if (!debugStructured) return;
  for (const diagnostic of diagnostics) {
    debugStructured(buildDeferredObjectiveDebugPayload(diagnostic));
  }
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

const canReportFreshProgressWhileUnknown = (reasonCode: DeferredObjectiveDiagnosticReasonCode): boolean => (
  reasonCode === 'objective_missing_price_horizon'
    || reasonCode === 'objective_price_feature_disabled'
);

const buildPolicyGatedKnownInputs = (
  base: DeferredObjectiveDiagnostic,
  progress: DeferredObjectiveProgressResolution,
  policyReasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
  ctx: { powerTracker: PowerTrackerState; deviceId: string; objective: DeferredObjectiveSettingsEntry },
): DeferredObjectiveDiagnostic => {
  const { powerTracker, deviceId, objective } = ctx;
  const { remainingUnits } = progress;
  if (!canReportFreshProgressWhileUnknown(policyReasonCode)) return base;

  const profileEnergy = !progress.reasonCode && remainingUnits > 0
    && policyReasonCode === 'objective_missing_price_horizon'
    ? resolveProfileEnergy({
      powerTracker,
      deviceId,
      objectiveKind: objective.kind,
      remainingUnits,
      currentValue: progressCurrentValue({ progress, objectiveKind: objective.kind }),
    })
    : null;

  return {
    ...base,
    currentPercent: !progress.reasonCode ? progress.currentPercent : null,
    currentTemperatureC: !progress.reasonCode ? progress.currentTemperatureC : null,
    ...(!progress.reasonCode && remainingUnits <= 0 ? { energyNeededKWh: 0 } : {}),
    ...(profileEnergy && !profileEnergy.reasonCode ? buildKnownEnergyFields({ objective, profileEnergy }) : {}),
  };
};

const buildDeferredObjectiveDiagnostic = (params: {
  nowMs: number;
  timeZone: string;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device?: PlanInputDevice;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs,
    timeZone,
    deviceId,
    objective,
    device,
    powerTracker,
    dailyBudgetSnapshot,
    priceOptimizationEnabled,
  } = params;
  const base = buildDiagnosticBase({
    deviceId,
    device,
    objective,
    timeZone,
    powerTracker,
    currentPercent: null,
    currentTemperatureC: null,
    energyNeededKWh: null,
    kWhPerPercent: null,
    kWhPerDegreeC: null,
    rateConfidence: null,
    kwhPerUnitSource: null,
  });
  if (!device) return withUnknown(base, 'objective_missing_device');

  if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= 0) {
    return withUnknown(base, 'objective_invalid_deadline');
  }
  const withDeadline = base;
  const progress = resolveObjectiveProgress({ objective, device, nowMs });
  if (!progress.reasonCode && progress.remainingUnits <= 0) {
    return buildDiagnosticWithPolicyHorizon({
      nowMs,
      deviceId,
      objective,
      device,
      powerTracker,
      base: withDeadline,
      progress,
      policyHorizon: { buckets: [], horizonBucketCount: 0, dailyBudgetExhaustedBucketCount: 0, reasonCode: null },
      deadlineAtMs: objective.deadlineAtMs,
    });
  }

  const policyHorizon = buildDeferredObjectivePolicyHorizon({
    nowMs,
    deadlineAtMs: objective.deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
  });
  if (policyHorizon.reasonCode) {
    const knownInputs = buildPolicyGatedKnownInputs(
      withDeadline,
      progress,
      policyHorizon.reasonCode,
      { powerTracker, deviceId, objective },
    );
    return withUnknown({
      ...knownInputs,
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, policyHorizon.reasonCode);
  }

  return buildDiagnosticWithPolicyHorizon({
    nowMs,
    deviceId,
    objective,
    device,
    powerTracker,
    base: withDeadline,
    progress,
    policyHorizon,
    deadlineAtMs: objective.deadlineAtMs,
  });
};

const buildDiagnosticWithPolicyHorizon = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device: PlanInputDevice;
  powerTracker: PowerTrackerState;
  base: DeferredObjectiveDiagnostic;
  progress: DeferredObjectiveProgressResolution;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  deadlineAtMs: number;
}): DeferredObjectiveDiagnostic => {
  const { nowMs, deviceId, objective, device, powerTracker, base, progress, policyHorizon, deadlineAtMs } = params;
  if (progress.reasonCode) {
    return withUnknown({
      ...base,
      currentPercent: progress.currentPercent,
      currentTemperatureC: progress.currentTemperatureC,
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, progress.reasonCode);
  }

  const profileEnergy: DeferredObjectiveEnergyResolution = progress.remainingUnits > 0
    ? resolveProfileEnergy({
      powerTracker,
      deviceId,
      objectiveKind: objective.kind,
      remainingUnits: progress.remainingUnits,
      currentValue: progressCurrentValue({ progress, objectiveKind: objective.kind }),
    })
    : {
      energyNeededKWh: 0,
      kWhPerUnit: null,
      rateConfidence: null,
      kwhPerUnitSource: null,
      reasonCode: null,
    };
  if (profileEnergy.reasonCode) {
    return withUnknown({
      ...base,
      currentPercent: progress.currentPercent,
      currentTemperatureC: progress.currentTemperatureC,
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, profileEnergy.reasonCode);
  }

  const steps = profileEnergy.energyNeededKWh > 0 ? resolveObjectiveSteps(device) : [];
  if (profileEnergy.energyNeededKWh > 0 && steps.length === 0) {
    return withUnknown({
      ...base,
      currentPercent: progress.currentPercent,
      currentTemperatureC: progress.currentTemperatureC,
      energyNeededKWh: profileEnergy.energyNeededKWh,
      kWhPerPercent: objective.kind === 'ev_soc' ? profileEnergy.kWhPerUnit : null,
      kWhPerDegreeC: objective.kind === 'temperature' ? profileEnergy.kWhPerUnit : null,
      rateConfidence: profileEnergy.rateConfidence,
      kwhPerUnitSource: profileEnergy.kwhPerUnitSource,
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, 'objective_missing_charge_rate');
  }

  const horizonPlan = planDeferredObjectiveHorizon({
    nowMs,
    objective: {
      id: `${deviceId}:${objective.kind}`,
      kind: objective.kind,
      enforcement: objective.enforcement,
      energyNeededKWh: profileEnergy.energyNeededKWh,
      deadlineAtMs,
      deadlineMarginMs: DEFAULT_DEADLINE_RESERVE_MS,
    },
    steps,
    buckets: policyHorizon.buckets,
  });

  return {
    ...base,
    status: horizonPlan.status,
    reasonCode: horizonPlan.statusDetail,
    currentPercent: progress.currentPercent,
    currentTemperatureC: progress.currentTemperatureC,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    kWhPerPercent: objective.kind === 'ev_soc' ? profileEnergy.kWhPerUnit : null,
    kWhPerDegreeC: objective.kind === 'temperature' ? profileEnergy.kWhPerUnit : null,
    rateConfidence: profileEnergy.rateConfidence,
    kwhPerUnitSource: profileEnergy.kwhPerUnitSource,
    horizonBucketCount: policyHorizon.horizonBucketCount,
    dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    requestedMinimumStepId: horizonPlan.requestedMinimumStepId,
    horizonPlan,
  };
};

const buildDiagnosticBase = (params: {
  deviceId: string;
  device?: PlanInputDevice;
  objective: DeferredObjectiveSettingsEntry;
  timeZone: string;
  powerTracker: PowerTrackerState;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
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
  return {
    deviceId: params.deviceId,
    deviceName: params.device?.name,
    objectiveId: `${params.deviceId}:${params.objective.kind}`,
    objectiveKind: params.objective.kind,
    enforcement: params.objective.enforcement,
    status: 'unknown',
    reasonCode: 'objective_progress_stale',
    targetPercent: params.objective.kind === 'ev_soc' ? params.objective.targetPercent : null,
    currentPercent: params.currentPercent,
    targetTemperatureC: params.objective.kind === 'temperature' ? params.objective.targetTemperatureC : null,
    currentTemperatureC: params.currentTemperatureC,
    deadlineAtMs,
    deadlineLocalTime: deadlineAtMs !== null ? formatDeadlineLocalTime(deadlineAtMs, params.timeZone) : '',
    energyNeededKWh: params.energyNeededKWh,
    kWhPerPercent: params.kWhPerPercent,
    kWhPerDegreeC: params.kWhPerDegreeC,
    rateConfidence: params.rateConfidence,
    kwhPerUnitSource: params.kwhPerUnitSource,
    kwhPerUnitAcceptedSamples: profileSnapshot.acceptedSamples,
    kwhPerUnitLastAcceptedAtMs: profileSnapshot.lastAcceptedAtMs,
    planningSpeedKw: resolvePlanningSpeedKw(params.device),
    horizonBucketCount: 0,
    dailyBudgetExhaustedBucketCount: 0,
    requestedMinimumStepId: null,
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

const withUnknown = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: DeferredObjectiveDiagnosticReasonCode,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  status: 'unknown',
  reasonCode,
  requestedMinimumStepId: null,
});

const buildKnownEnergyFields = (params: {
  objective: DeferredObjectiveSettingsEntry;
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>;
}): Pick<
  DeferredObjectiveDiagnostic,
  'energyNeededKWh' | 'kWhPerPercent' | 'kWhPerDegreeC' | 'rateConfidence' | 'kwhPerUnitSource'
> => ({
  energyNeededKWh: params.profileEnergy.energyNeededKWh,
  kWhPerPercent: params.objective.kind === 'ev_soc' ? params.profileEnergy.kWhPerUnit : null,
  kWhPerDegreeC: params.objective.kind === 'temperature' ? params.profileEnergy.kWhPerUnit : null,
  rateConfidence: params.profileEnergy.rateConfidence,
  kwhPerUnitSource: params.profileEnergy.kwhPerUnitSource,
});

const resolveObjectiveSteps = (device: PlanInputDevice): DeferredObjectiveStep[] => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    return sortSteppedLoadSteps(profile.steps).map((step) => ({
      id: step.id,
      usefulPowerKw: resolveStepDeliveryUsefulKw(device, step.id, step.planningPowerW / 1000),
    }));
  }
  // EV chargers go through the same calibrated lookup as stepped devices so
  // the allocator's per-step useful power agrees with the hero's planning-
  // speed reading. Without this, a confident calibration below nameplate
  // would let the allocator over-promise delivery while the hero shows a
  // slower speed.
  const planning = device.planningPowerKw;
  if (typeof planning === 'number' && Number.isFinite(planning) && planning > 0) {
    return [{ id: 'charge', usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', planning) }];
  }
  if (device.deviceClass === 'evcharger') {
    const expected = firstPositiveFinite([device.expectedPowerKw, device.powerKw]);
    if (expected !== null) {
      return [{ id: 'charge', usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', expected) }];
    }
  }
  return [];
};
