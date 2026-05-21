import type { PowerTrackerState } from '../../core/powerTracker';
import {
  resolveProfileEnergy,
  type DeferredObjectiveEnergyResolution,
  type DeferredObjectiveKwhPerUnitSource,
} from './profileEnergyResolution';
import { buildDeferredObjectiveDebugPayload } from './diagnosticDebugPayload';
import type { DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import type { PlanInputDevice } from '../planTypes';
import { formatDeadlineLocalTime } from './deadline';
import { resolveHorizonPlanWithRescue } from './rescueReplan';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { resolveCommittedHours } from './resolveCommittedHours';
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
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from './settings';
import type {
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from './types';

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

type BaseDeferredObjectiveDiagnostic = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  enforcement: DeferredObjectiveSettingsEntry['enforcement'];
  status: 'unknown' | DeferredObjectiveHorizonPlan['status'];
  reasonCode: DeferredObjectiveDiagnosticReasonCode | DeferredObjectiveHorizonPlan['statusDetail'];
  targetPercent: number | null;
  currentPercent: number | null;
  deadlineAtMs: number | null;
  deadlineLocalTime: string;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
  // Band-aware aggregated confidence for the smart-task chip. Honest about
  // whether the *model in use* (bands integrated for this resolution) is
  // well-supported, instead of the raw per-sample CV which sits at "low" on
  // thermal devices effectively forever. Null on bootstrap / unresolved.
  displayConfidence: 'low' | 'medium' | 'high' | null;
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
  // Planning-affecting rescue permissions participate in the active-plan signature
  // so permission edits invalidate stale committed schedules.
  rescue?: DeferredObjectiveRescuePermissions;
  horizonBucketCount: number;
  // Number of buckets in the horizon whose per-bucket cap collapsed to zero
  // because the daily budget cap had already been reached at the start of the
  // bucket. Lets the UI explain a `cannot_meet` outcome that would otherwise
  // look like a device or schedule problem.
  dailyBudgetExhaustedBucketCount: number;
  requestedMinimumStepId: string | null;
  horizonPlan?: DeferredObjectiveHorizonPlan;
  // True only while the current bucket is a planned bucket for a smart task whose "exempt
  // from budget" rescue permission is active. Admission consumes this flat flag to set the
  // device's existing `budgetExempt` for that bucket; idle/background cycles stay normal.
  budgetExemptApplied?: boolean;
  // True when the "limit lower-priority devices" rescue permission is granted (mode
  // 'always'). Admission consumes this flat flag to engage the device's boost while the
  // task is in its planned hours, so the existing escalation/shedding machinery claims
  // capacity from lower-priority devices. Producer resolves it; consumers don't re-derive.
  limitLowerPriorityApplied?: boolean;
};

// Discriminated by `objectiveKind`. Temperature variants always carry a
// numeric `targetTemperatureC` (the setting requires it); EV variants omit
// both temperature fields entirely so consumers can't accidentally read
// them. `currentTemperatureC` stays `number | null` on the temperature
// variant because sensor reads can legitimately fail.
export type DeferredObjectiveDiagnostic =
  | (BaseDeferredObjectiveDiagnostic & {
    objectiveKind: 'temperature';
    targetTemperatureC: number;
    currentTemperatureC: number | null;
  })
  | (BaseDeferredObjectiveDiagnostic & {
    objectiveKind: 'ev_soc';
    targetTemperatureC?: never;
    currentTemperatureC?: never;
  });

export const buildDeferredObjectiveDiagnostics = (params: {
  nowMs: number;
  timeZone: string;
  devices: PlanInputDevice[];
  settings: DeferredObjectiveSettingsV1;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceOptimizationEnabled: boolean;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
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

// Variant-preserving merge of progress-derived fields onto an existing
// diagnostic. The discriminated union forbids assigning
// `currentTemperatureC` on the EV variant, so we branch on the diagnostic's
// own `objectiveKind` rather than spreading both fields blindly.
const mergeProgressFields = (
  base: DeferredObjectiveDiagnostic,
  currentPercent: number | null,
  currentTemperatureC: number | null,
): DeferredObjectiveDiagnostic => {
  if (base.objectiveKind === 'temperature') {
    return { ...base, currentPercent, currentTemperatureC };
  }
  return { ...base, currentPercent };
};

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

  const withProgress = mergeProgressFields(
    base,
    !progress.reasonCode ? progress.currentPercent : null,
    !progress.reasonCode ? progress.currentTemperatureC : null,
  );
  return {
    ...withProgress,
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
  activePlans?: DeferredObjectiveActivePlansV1 | null;
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
    activePlans,
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
    displayConfidence: null,
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
      priceOptimizationEnabled,
      dailyBudgetSnapshot,
      activePlans,
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
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    activePlans,
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
  priceOptimizationEnabled: boolean;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
}): DeferredObjectiveDiagnostic => {
  const {
    nowMs,
    deviceId,
    objective,
    device,
    powerTracker,
    base,
    progress,
    policyHorizon,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    activePlans,
  } = params;
  if (progress.reasonCode) {
    return withUnknown({
      ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
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
      displayConfidence: null,
      kwhPerUnitSource: null,
      reasonCode: null,
    };
  if (profileEnergy.reasonCode) {
    return withUnknown({
      ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, profileEnergy.reasonCode);
  }

  const steps = profileEnergy.energyNeededKWh > 0 ? resolveObjectiveSteps(device) : [];
  if (profileEnergy.energyNeededKWh > 0 && steps.length === 0) {
    return withUnknown({
      ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
      energyNeededKWh: profileEnergy.energyNeededKWh,
      kWhPerPercent: objective.kind === 'ev_soc' ? profileEnergy.kWhPerUnit : null,
      kWhPerDegreeC: objective.kind === 'temperature' ? profileEnergy.kWhPerUnit : null,
      rateConfidence: profileEnergy.rateConfidence,
      displayConfidence: profileEnergy.displayConfidence,
      kwhPerUnitSource: profileEnergy.kwhPerUnitSource,
      horizonBucketCount: policyHorizon.horizonBucketCount,
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    }, 'objective_missing_charge_rate');
  }

  const commitment = resolveCommittedHours({
    activePlans,
    deviceId,
    objective,
  });
  const { plan: horizonPlan, dailyBudgetExhaustedBucketCount } = resolveHorizonPlanWithRescue({
    nowMs,
    deviceId,
    objective,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    deadlineAtMs,
    steps,
    commitment,
    policyHorizon,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
  });

  return {
    ...mergeProgressFields(base, progress.currentPercent, progress.currentTemperatureC),
    status: horizonPlan.status,
    reasonCode: horizonPlan.statusDetail,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    kWhPerPercent: objective.kind === 'ev_soc' ? profileEnergy.kWhPerUnit : null,
    kWhPerDegreeC: objective.kind === 'temperature' ? profileEnergy.kWhPerUnit : null,
    rateConfidence: profileEnergy.rateConfidence,
    displayConfidence: profileEnergy.displayConfidence,
    kwhPerUnitSource: profileEnergy.kwhPerUnitSource,
    horizonBucketCount: policyHorizon.horizonBucketCount,
    dailyBudgetExhaustedBucketCount,
    requestedMinimumStepId: horizonPlan.requestedMinimumStepId,
    budgetExemptApplied: objective.rescue?.exemptFromBudget === 'always'
      && isCurrentBucketPlanned(horizonPlan),
    limitLowerPriorityApplied: objective.rescue?.limitLowerPriorityDevices === 'always',
    horizonPlan,
  };
};

const isCurrentBucketPlanned = (horizonPlan: DeferredObjectiveHorizonPlan): boolean => (
  (horizonPlan.currentBucket?.plannedUsefulEnergyKWh ?? 0) > 0
);

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
    deadlineAtMs,
    deadlineLocalTime: deadlineAtMs !== null ? formatDeadlineLocalTime(deadlineAtMs, params.timeZone) : '',
    energyNeededKWh: params.energyNeededKWh,
    kWhPerPercent: params.kWhPerPercent,
    kWhPerDegreeC: params.kWhPerDegreeC,
    rateConfidence: params.rateConfidence,
    displayConfidence: params.displayConfidence,
    kwhPerUnitSource: params.kwhPerUnitSource,
    kwhPerUnitAcceptedSamples: profileSnapshot.acceptedSamples,
    kwhPerUnitLastAcceptedAtMs: profileSnapshot.lastAcceptedAtMs,
    planningSpeedKw: resolvePlanningSpeedKw(params.device),
    horizonBucketCount: 0,
    dailyBudgetExhaustedBucketCount: 0,
    requestedMinimumStepId: null,
  };
  if (params.objective.kind === 'temperature') {
    return {
      ...common,
      objectiveKind: 'temperature',
      targetTemperatureC: params.objective.targetTemperatureC,
      currentTemperatureC: params.currentTemperatureC,
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
  'energyNeededKWh' | 'kWhPerPercent' | 'kWhPerDegreeC' | 'rateConfidence' | 'displayConfidence' | 'kwhPerUnitSource'
> => ({
  energyNeededKWh: params.profileEnergy.energyNeededKWh,
  kWhPerPercent: params.objective.kind === 'ev_soc' ? params.profileEnergy.kWhPerUnit : null,
  kWhPerDegreeC: params.objective.kind === 'temperature' ? params.profileEnergy.kWhPerUnit : null,
  rateConfidence: params.profileEnergy.rateConfidence,
  displayConfidence: params.profileEnergy.displayConfidence,
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
