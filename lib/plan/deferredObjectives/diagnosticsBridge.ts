import type { PowerTrackerState } from '../../core/powerTracker';
import type { DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import type { PlanInputDevice } from '../planTypes';
import { resolveDeferredObjectiveDeadline } from './deadline';
import { planDeferredObjectiveHorizon } from './horizonPlanner';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonUnavailableReason,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsV1 } from './settings';
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
  | 'objective_progress_stale';

export type DeferredObjectiveDiagnostic = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  objectiveKind: 'ev_soc';
  enforcement: DeferredObjectiveSettingsEntry['enforcement'];
  status: 'unknown' | DeferredObjectiveHorizonPlan['status'];
  reasonCode: DeferredObjectiveDiagnosticReasonCode | DeferredObjectiveHorizonPlan['statusDetail'];
  targetPercent: number;
  currentPercent: number | null;
  deadlineAtMs: number | null;
  deadlineLocalTime: string;
  deadlineRollsToNextDay: boolean;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  rateConfidence: string | null;
  horizonBucketCount: number;
  requestedMinimumStepId: string | null;
  horizonPlan?: DeferredObjectiveHorizonPlan;
};

type DeferredObjectiveEnergyResolution = {
  energyNeededKWh: number;
  kWhPerPercent: number | null;
  rateConfidence: string | null;
  reasonCode: null;
} | {
  energyNeededKWh: null;
  kWhPerPercent: null;
  rateConfidence: null;
  reasonCode: 'objective_missing_capacity';
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
    energyNeededKWh: null,
    kWhPerPercent: null,
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

  const progress = resolveEvObjectiveProgress(device);
  if (progress.reasonCode) {
    return withUnknown({
      ...withDeadline,
      currentPercent: progress.currentPercent,
      horizonBucketCount: policyHorizon.horizonBucketCount,
    }, progress.reasonCode);
  }

  const remainingPercent = Math.max(0, objective.targetPercent - progress.currentPercent);
  const profileEnergy: DeferredObjectiveEnergyResolution = remainingPercent > 0
    ? resolveProfileEnergy({ powerTracker, deviceId, remainingPercent })
    : {
      energyNeededKWh: 0,
      kWhPerPercent: null,
      rateConfidence: null,
      reasonCode: null,
    };
  if (profileEnergy.reasonCode) {
    return withUnknown({
      ...withDeadline,
      currentPercent: progress.currentPercent,
      horizonBucketCount: policyHorizon.horizonBucketCount,
    }, profileEnergy.reasonCode);
  }

  const steps = profileEnergy.energyNeededKWh > 0 ? resolveObjectiveSteps(device) : [];
  if (profileEnergy.energyNeededKWh > 0 && steps.length === 0) {
    return withUnknown({
      ...withDeadline,
      currentPercent: progress.currentPercent,
      energyNeededKWh: profileEnergy.energyNeededKWh,
      kWhPerPercent: profileEnergy.kWhPerPercent,
      rateConfidence: profileEnergy.rateConfidence,
      horizonBucketCount: policyHorizon.horizonBucketCount,
    }, 'objective_missing_charge_rate');
  }

  const horizonPlan = planDeferredObjectiveHorizon({
    nowMs,
    objective: {
      id: `${deviceId}:ev_soc`,
      kind: 'ev_soc',
      enforcement: objective.enforcement,
      energyNeededKWh: profileEnergy.energyNeededKWh,
      deadlineAtMs: deadline.deadlineAtMs,
    },
    steps,
    buckets: policyHorizon.buckets,
  });

  return {
    ...withDeadline,
    status: horizonPlan.status,
    reasonCode: horizonPlan.statusDetail,
    currentPercent: progress.currentPercent,
    energyNeededKWh: profileEnergy.energyNeededKWh,
    kWhPerPercent: profileEnergy.kWhPerPercent,
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
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  rateConfidence: string | null;
}): DeferredObjectiveDiagnostic => ({
  deviceId: params.deviceId,
  deviceName: params.device?.name,
  objectiveId: `${params.deviceId}:ev_soc`,
  objectiveKind: 'ev_soc',
  enforcement: params.objective.enforcement,
  status: 'unknown',
  reasonCode: 'objective_progress_stale',
  targetPercent: params.objective.targetPercent,
  currentPercent: params.currentPercent,
  deadlineAtMs: params.deadlineAtMs,
  deadlineLocalTime: params.objective.deadlineLocalTime,
  deadlineRollsToNextDay: params.deadlineRollsToNextDay,
  energyNeededKWh: params.energyNeededKWh,
  kWhPerPercent: params.kWhPerPercent,
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

const resolveProfileEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  remainingPercent: number;
}): DeferredObjectiveEnergyResolution => {
  const profile = params.powerTracker.objectiveProfiles?.[params.deviceId];
  const kWhPerPercent = profile?.kind === 'ev_soc' ? profile.kwhPerUnit : undefined;
  if (!kWhPerPercent || !Number.isFinite(kWhPerPercent.mean) || kWhPerPercent.mean <= 0) {
    return {
      energyNeededKWh: null,
      kWhPerPercent: null,
      rateConfidence: null,
      reasonCode: 'objective_missing_capacity',
    };
  }
  return {
    energyNeededKWh: params.remainingPercent * kWhPerPercent.mean,
    kWhPerPercent: kWhPerPercent.mean,
    rateConfidence: kWhPerPercent.confidence,
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
  energyNeededKWh: diagnostic.energyNeededKWh,
  kWhPerPercent: diagnostic.kWhPerPercent,
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
