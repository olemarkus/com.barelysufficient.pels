import type { PowerTrackerState } from '../../core/powerTracker';
import {
  OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS,
  OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS,
} from '../../core/objectiveProfiles';
import type { DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import type { PlanInputDevice } from '../planTypes';
import { resolveDeferredObjectiveDeadline } from './deadline';
import { planDeferredObjectiveHorizon } from './horizonPlanner';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePolicyHorizonUnavailableReason,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsV1 } from './settings';
import type {
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveKind,
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
  deadlineRollsToNextDay: boolean;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
  horizonBucketCount: number;
  requestedMinimumStepId: string | null;
  horizonPlan?: DeferredObjectiveHorizonPlan;
};

type DeferredObjectiveEnergyResolution = {
  energyNeededKWh: number;
  kWhPerUnit: number | null;
  rateConfidence: string | null;
  reasonCode: null;
} | {
  energyNeededKWh: null;
  kWhPerUnit: null;
  rateConfidence: null;
  reasonCode: 'objective_missing_capacity';
};

type DeferredObjectiveProgressResolution = {
  remainingUnits: number;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  reasonCode: null;
} | {
  remainingUnits: 0;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  reasonCode: 'objective_invalid_session' | 'objective_missing_temperature' | 'objective_progress_stale';
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
    deadlineAtMs: null,
    deadlineRollsToNextDay: false,
    currentPercent: null,
    currentTemperatureC: null,
    energyNeededKWh: null,
    kWhPerPercent: null,
    kWhPerDegreeC: null,
    rateConfidence: null,
  });
  if (!device) return withUnknown(base, 'objective_missing_device');

  const deadline = resolveDeferredObjectiveDeadline({
    nowMs,
    timeZone,
    deadlineLocalTime: objective.deadlineLocalTime,
  });
  const withDeadline = {
    ...base,
    deadlineAtMs: deadline.deadlineAtMs,
    deadlineRollsToNextDay: deadline.rollsToNextDay,
  };
  if (deadline.deadlineAtMs === null) return withUnknown(withDeadline, 'objective_invalid_deadline');

  const policyHorizon = buildDeferredObjectivePolicyHorizon({
    nowMs,
    deadlineAtMs: deadline.deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
  });
  if (policyHorizon.reasonCode) {
    return withUnknown({
      ...withDeadline,
      horizonBucketCount: policyHorizon.horizonBucketCount,
    }, policyHorizon.reasonCode);
  }

  return buildDiagnosticWithPolicyHorizon({
    nowMs,
    deviceId,
    objective,
    device,
    powerTracker,
    base: withDeadline,
    policyHorizon,
    deadlineAtMs: deadline.deadlineAtMs,
  });
};

const buildDiagnosticWithPolicyHorizon = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  device: PlanInputDevice;
  powerTracker: PowerTrackerState;
  base: DeferredObjectiveDiagnostic;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  deadlineAtMs: number;
}): DeferredObjectiveDiagnostic => {
  const { nowMs, deviceId, objective, device, powerTracker, base, policyHorizon, deadlineAtMs } = params;
  const progress = resolveObjectiveProgress({ objective, device, nowMs });
  if (progress.reasonCode) {
    return withUnknown({
      ...base,
      currentPercent: progress.currentPercent,
      currentTemperatureC: progress.currentTemperatureC,
      horizonBucketCount: policyHorizon.horizonBucketCount,
    }, progress.reasonCode);
  }

  const profileEnergy: DeferredObjectiveEnergyResolution = progress.remainingUnits > 0
    ? resolveProfileEnergy({
      powerTracker,
      deviceId,
      objectiveKind: objective.kind,
      remainingUnits: progress.remainingUnits,
    })
    : {
      energyNeededKWh: 0,
      kWhPerUnit: null,
      rateConfidence: null,
      reasonCode: null,
    };
  if (profileEnergy.reasonCode) {
    return withUnknown({
      ...base,
      currentPercent: progress.currentPercent,
      currentTemperatureC: progress.currentTemperatureC,
      horizonBucketCount: policyHorizon.horizonBucketCount,
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
      horizonBucketCount: policyHorizon.horizonBucketCount,
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
    horizonBucketCount: policyHorizon.horizonBucketCount,
    requestedMinimumStepId: horizonPlan.requestedMinimumStepId,
    horizonPlan,
  };
};

const buildDiagnosticBase = (params: {
  deviceId: string;
  device?: PlanInputDevice;
  objective: DeferredObjectiveSettingsEntry;
  deadlineAtMs: number | null;
  deadlineRollsToNextDay: boolean;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
}): DeferredObjectiveDiagnostic => ({
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
  deadlineAtMs: params.deadlineAtMs,
  deadlineLocalTime: params.objective.deadlineLocalTime,
  deadlineRollsToNextDay: params.deadlineRollsToNextDay,
  energyNeededKWh: params.energyNeededKWh,
  kWhPerPercent: params.kWhPerPercent,
  kWhPerDegreeC: params.kWhPerDegreeC,
  rateConfidence: params.rateConfidence,
  horizonBucketCount: 0,
  requestedMinimumStepId: null,
});

const withUnknown = (
  diagnostic: DeferredObjectiveDiagnostic,
  reasonCode: DeferredObjectiveDiagnosticReasonCode,
): DeferredObjectiveDiagnostic => ({
  ...diagnostic,
  status: 'unknown',
  reasonCode,
  requestedMinimumStepId: null,
});

const resolveEvObjectiveProgress = (
  device: PlanInputDevice,
): {
  currentPercent: number;
  reasonCode: null;
} | {
  currentPercent: number | null;
  reasonCode: 'objective_invalid_session' | 'objective_progress_stale';
} => {
  if (device.evChargingState === 'plugged_out' || device.evChargingState === 'plugged_in_discharging') {
    return { currentPercent: null, reasonCode: 'objective_invalid_session' };
  }
  const stateOfCharge = device.stateOfCharge;
  if (!stateOfCharge || stateOfCharge.status !== 'fresh' || !Number.isFinite(stateOfCharge.percent)) {
    return {
      currentPercent: typeof stateOfCharge?.percent === 'number' && Number.isFinite(stateOfCharge.percent)
        ? stateOfCharge.percent
        : null,
      reasonCode: stateOfCharge?.status === 'invalid' ? 'objective_invalid_session' : 'objective_progress_stale',
    };
  }
  return { currentPercent: stateOfCharge.percent, reasonCode: null };
};

const resolveObjectiveProgress = (params: {
  objective: DeferredObjectiveSettingsEntry;
  device: PlanInputDevice;
  nowMs: number;
}): DeferredObjectiveProgressResolution => {
  const { objective, device, nowMs } = params;
  if (objective.kind === 'ev_soc') {
    const progress = resolveEvObjectiveProgress(device);
    if (progress.reasonCode) {
      return {
        remainingUnits: 0,
        currentPercent: progress.currentPercent,
        currentTemperatureC: null,
        reasonCode: progress.reasonCode,
      };
    }
    return {
      remainingUnits: Math.max(0, objective.targetPercent - progress.currentPercent),
      currentPercent: progress.currentPercent,
      currentTemperatureC: null,
      reasonCode: null,
    };
  }

  const currentTemperatureC = device.currentTemperature;
  if (!hasFreshTemperatureProgress({ device, nowMs })) {
    return {
      remainingUnits: 0,
      currentPercent: null,
      currentTemperatureC: typeof currentTemperatureC === 'number' && Number.isFinite(currentTemperatureC)
        ? currentTemperatureC
        : null,
      reasonCode: typeof currentTemperatureC === 'number' && Number.isFinite(currentTemperatureC)
        ? 'objective_progress_stale'
        : 'objective_missing_temperature',
    };
  }
  const freshTemperatureC = Number(device.currentTemperature);
  return {
    remainingUnits: Math.max(0, objective.targetTemperatureC - freshTemperatureC),
    currentPercent: null,
    currentTemperatureC: freshTemperatureC,
    reasonCode: null,
  };
};

const hasFreshTemperatureProgress = (params: {
  device: PlanInputDevice;
  nowMs: number;
}): params is { device: PlanInputDevice & { currentTemperature: number; lastFreshDataMs: number }; nowMs: number } => {
  const { device, nowMs } = params;
  if (device.observationStale === true) return false;
  if (typeof device.currentTemperature !== 'number' || !Number.isFinite(device.currentTemperature)) return false;
  if (typeof device.lastFreshDataMs !== 'number' || !Number.isFinite(device.lastFreshDataMs)) return false;
  if (device.lastFreshDataMs > nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS) return false;
  return nowMs - device.lastFreshDataMs <= OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS;
};

const resolveProfileEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objectiveKind: DeferredObjectiveKind;
  remainingUnits: number;
}): DeferredObjectiveEnergyResolution => {
  const profile = params.powerTracker.objectiveProfiles?.[params.deviceId];
  const kWhPerUnit = profile?.kind === params.objectiveKind ? profile.kwhPerUnit : undefined;
  if (!kWhPerUnit || !Number.isFinite(kWhPerUnit.mean) || kWhPerUnit.mean <= 0) {
    return {
      energyNeededKWh: null,
      kWhPerUnit: null,
      rateConfidence: null,
      reasonCode: 'objective_missing_capacity',
    };
  }
  return {
    energyNeededKWh: params.remainingUnits * kWhPerUnit.mean,
    kWhPerUnit: kWhPerUnit.mean,
    rateConfidence: kWhPerUnit.confidence,
    reasonCode: null,
  };
};

const resolveObjectiveSteps = (device: PlanInputDevice): DeferredObjectiveStep[] => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    return sortSteppedLoadSteps(profile.steps).map((step) => ({
      id: step.id,
      usefulPowerKw: step.planningPowerW / 1000,
    }));
  }
  if (
    typeof device.planningPowerKw === 'number'
    && Number.isFinite(device.planningPowerKw)
    && device.planningPowerKw > 0
  ) {
    return [{ id: 'charge', usefulPowerKw: device.planningPowerKw }];
  }
  return [];
};

const buildDeferredObjectiveDebugPayload = (
  diagnostic: DeferredObjectiveDiagnostic,
): Record<string, unknown> => ({
  event: diagnostic.status === 'unknown'
    ? 'deferred_objective_unknown'
    : 'deferred_objective_horizon_planned',
  deviceId: diagnostic.deviceId,
  ...(diagnostic.deviceName ? { deviceName: diagnostic.deviceName } : {}),
  objectiveId: diagnostic.objectiveId,
  objectiveKind: diagnostic.objectiveKind,
  enforcement: diagnostic.enforcement,
  status: diagnostic.status,
  reasonCode: diagnostic.reasonCode,
  targetPercent: diagnostic.targetPercent,
  currentPercent: diagnostic.currentPercent,
  targetTemperatureC: diagnostic.targetTemperatureC,
  currentTemperatureC: diagnostic.currentTemperatureC,
  energyNeededKWh: diagnostic.energyNeededKWh,
  kWhPerPercent: diagnostic.kWhPerPercent,
  kWhPerDegreeC: diagnostic.kWhPerDegreeC,
  rateConfidence: diagnostic.rateConfidence,
  deadlineAtMs: diagnostic.deadlineAtMs,
  deadlineLocalTime: diagnostic.deadlineLocalTime,
  deadlineRollsToNextDay: diagnostic.deadlineRollsToNextDay,
  horizonBucketCount: diagnostic.horizonBucketCount,
  requestedMinimumStepId: diagnostic.requestedMinimumStepId,
  plannedUsefulEnergyKWh: diagnostic.horizonPlan?.plannedUsefulEnergyKWh ?? null,
  unplannedUsefulEnergyKWh: diagnostic.horizonPlan?.unplannedUsefulEnergyKWh ?? null,
  usesDeadlineReserve: diagnostic.horizonPlan?.usesDeadlineReserve ?? null,
  usesPolicyAvoid: diagnostic.horizonPlan?.usesPolicyAvoid ?? null,
  plannedBuckets: diagnostic.horizonPlan?.plannedBuckets.map((bucket) => ({
    id: bucket.id,
    startMs: bucket.startMs,
    endMs: bucket.endMs,
    preference: bucket.preference,
    reserve: bucket.reserve,
    current: bucket.current,
    plannedUsefulEnergyKWh: bucket.plannedUsefulEnergyKWh,
  })) ?? null,
});
