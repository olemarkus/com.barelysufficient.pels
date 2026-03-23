/* eslint-disable
  complexity,
  no-nested-ternary,
  functional/immutable-data,
  no-param-reassign
-- runtime step-state decoration intentionally centralizes mutation and fallback resolution. */
import {
  getSteppedLoadHighestStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
  normalizeDeviceControlProfiles,
  resolveSteppedLoadPlanningPowerKw,
  resolveSteppedLoadPowerHeuristicStepId,
} from '../utils/deviceControlProfiles';
import type {
  DeviceControlModel,
  DeviceControlProfiles,
  SteppedLoadCommandStatus,
  TargetDeviceSnapshot,
} from '../utils/types';

export const STEPPED_LOAD_COMMAND_STALE_MS = 90 * 1000;

export type SteppedLoadDesiredRuntimeState = {
  stepId: string;
  previousStepId?: string;
  changedAtMs: number;
  lastIssuedAtMs?: number;
  pending: boolean;
  status: SteppedLoadCommandStatus;
};

export type SteppedLoadReportedRuntimeState = {
  stepId: string;
  updatedAtMs: number;
};

export type DeviceControlRuntimeState = {
  steppedLoadDesiredByDeviceId: Record<string, SteppedLoadDesiredRuntimeState>;
  steppedLoadReportedByDeviceId: Record<string, SteppedLoadReportedRuntimeState>;
};

export type ReportSteppedLoadActualStepResult = 'changed' | 'unchanged' | 'invalid';

export const createDeviceControlRuntimeState = (): DeviceControlRuntimeState => ({
  steppedLoadDesiredByDeviceId: {},
  steppedLoadReportedByDeviceId: {},
});

export const normalizeStoredDeviceControlProfiles = normalizeDeviceControlProfiles;

export const resolveDefaultControlModel = (device: TargetDeviceSnapshot): DeviceControlModel => {
  if (device.controlModel) return device.controlModel;
  if (device.deviceType === 'temperature') return 'temperature_target';
  return 'binary_power';
};

export const decorateSnapshotWithDeviceControl = (params: {
  snapshot: TargetDeviceSnapshot;
  profiles: DeviceControlProfiles;
  runtimeState: DeviceControlRuntimeState;
  nowMs?: number;
}): TargetDeviceSnapshot => {
  const { snapshot, profiles, runtimeState, nowMs = Date.now() } = params;
  const profile = profiles[snapshot.id];
  if (!profile || profile.model !== 'stepped_load') {
    return {
      ...snapshot,
      controlModel: resolveDefaultControlModel(snapshot),
    };
  }

  pruneStaleSteppedLoadCommandStates(runtimeState, nowMs);

  const desired = runtimeState.steppedLoadDesiredByDeviceId[snapshot.id];
  const reported = runtimeState.steppedLoadReportedByDeviceId[snapshot.id];
  const reportedStepId = getSteppedLoadStep(profile, reported?.stepId)?.id;
  const desiredStepId = getSteppedLoadStep(profile, desired?.stepId)?.id;
  const heuristicStepId = resolveSteppedLoadPowerHeuristicStepId(profile, snapshot.measuredPowerKw);
  const defaultStepId = getSteppedLoadHighestStep(profile)?.id;
  const selectedStepId = reportedStepId ?? heuristicStepId ?? defaultStepId;
  const actualStepId = reportedStepId ?? heuristicStepId;
  const actualStepSource = reportedStepId
    ? 'reported'
    : heuristicStepId
      ? 'power_heuristic'
      : undefined;
  const assumedStepId = reportedStepId ? undefined : heuristicStepId ?? defaultStepId;
  const planningPowerKw = resolveSteppedLoadPlanningPowerKw(profile, selectedStepId);

  return {
    ...snapshot,
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    selectedStepId,
    desiredStepId,
    actualStepId,
    assumedStepId,
    actualStepSource,
    planningPowerKw,
    // Preserve an explicit off state from the raw onoff capability for stepped devices. A device
    // at a non-zero step but with onoff=false is genuinely off — the step is configuration, not
    // power state. An explicit on state may still be overridden by an off-step selection.
    currentOn: snapshot.currentOn !== false
      && (selectedStepId ? !isSteppedLoadOffStep(profile, selectedStepId) : snapshot.currentOn),
    lastDesiredStepChangeAt: desired?.changedAtMs,
    lastStepCommandIssuedAt: desired?.lastIssuedAtMs,
    stepCommandPending: desired?.pending ?? false,
    stepCommandStatus: desired?.status ?? 'idle',
  };
};

export const markSteppedLoadDesiredStepIssued = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
}): void => {
  const {
    runtimeState,
    deviceId,
    desiredStepId,
    previousStepId,
    issuedAtMs = Date.now(),
  } = params;
  runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
    stepId: desiredStepId,
    previousStepId,
    changedAtMs: issuedAtMs,
    lastIssuedAtMs: issuedAtMs,
    pending: true,
    status: 'pending',
  };
};

export const reportSteppedLoadActualStep = (params: {
  runtimeState: DeviceControlRuntimeState;
  profiles: DeviceControlProfiles;
  deviceId: string;
  stepId: string;
  reportedAtMs?: number;
}): ReportSteppedLoadActualStepResult => {
  const {
    runtimeState,
    profiles,
    deviceId,
    stepId,
    reportedAtMs = Date.now(),
  } = params;
  const profile = profiles[deviceId];
  if (!profile || profile.model !== 'stepped_load' || !getSteppedLoadStep(profile, stepId)) {
    return 'invalid';
  }

  const previousReport = runtimeState.steppedLoadReportedByDeviceId[deviceId];
  runtimeState.steppedLoadReportedByDeviceId[deviceId] = {
    stepId,
    updatedAtMs: reportedAtMs,
  };

  const desired = runtimeState.steppedLoadDesiredByDeviceId[deviceId];
  if (desired?.stepId === stepId) {
    runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
      ...desired,
      pending: false,
      status: 'success',
    };
  }

  return previousReport?.stepId !== stepId ? 'changed' : 'unchanged';
};

export const pruneStaleSteppedLoadCommandStates = (
  runtimeState: DeviceControlRuntimeState,
  nowMs: number = Date.now(),
): boolean => {
  let changed = false;
  for (const [deviceId, desired] of Object.entries(runtimeState.steppedLoadDesiredByDeviceId)) {
    if (!desired.pending || typeof desired.lastIssuedAtMs !== 'number') continue;
    if (nowMs - desired.lastIssuedAtMs < STEPPED_LOAD_COMMAND_STALE_MS) continue;
    runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
      ...desired,
      pending: false,
      status: 'stale',
    };
    changed = true;
  }
  return changed;
};
