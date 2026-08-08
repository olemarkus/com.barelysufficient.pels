import type { Logger as PinoLogger } from '../lib/logging/logger';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { getSteppedLoadStep } from '../lib/utils/deviceControlProfiles';
import type { DevicePlan } from '../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../packages/contracts/src/types';
import type { SteppedLoadDesiredRuntimeState } from './appDeviceControlSteppedCommandState';

export function isValidSteppedLoadFeedbackProfile(
  profile: SteppedLoadProfile | null,
  stepId: string,
): profile is SteppedLoadProfile {
  return profile?.model === 'stepped_load' && getSteppedLoadStep(profile, stepId) !== undefined;
}

export function resolvePreviousDesiredStepId(
  profile: SteppedLoadProfile,
  previousDesired: SteppedLoadDesiredRuntimeState | undefined,
): string | undefined {
  return getSteppedLoadStep(profile, previousDesired?.stepId)?.id;
}

export function resolveLatestPlanDesiredStepId(params: {
  plan: DevicePlan | null | undefined;
  deviceId: string;
  profile: SteppedLoadProfile;
}): string | undefined {
  const plannedDevice = params.plan?.devices.find((device) => device.id === params.deviceId);
  return getSteppedLoadStep(
    params.profile,
    plannedDevice?.targetStepId ?? plannedDevice?.desiredStepId,
  )?.id;
}

export function resolvePlannedDesiredStepToPreserve(params: {
  previousDesired: SteppedLoadDesiredRuntimeState | undefined;
  previousDesiredStepId: string | undefined;
  latestPlanDesiredStepId: string | undefined;
  plannedDesiredStepId: string | undefined;
  reportedStepId: string;
}): string | undefined {
  const {
    previousDesired,
    previousDesiredStepId,
    latestPlanDesiredStepId,
    plannedDesiredStepId,
    reportedStepId,
  } = params;
  if (!plannedDesiredStepId) return undefined;
  if (latestPlanDesiredStepId && previousDesired && previousDesiredStepId !== latestPlanDesiredStepId) {
    return latestPlanDesiredStepId;
  }
  return !previousDesired && plannedDesiredStepId !== reportedStepId ? plannedDesiredStepId : undefined;
}

export function emitSteppedFeedbackLog(params: {
  log: PinoLogger | undefined;
  deviceId: string;
  deviceName: string;
  stepId: string;
  previousReportedStepId: string | undefined;
  previousDesired: SteppedLoadDesiredRuntimeState | undefined;
  plannedDesiredStepId: string | undefined;
}): void {
  const {
    log,
    deviceId,
    deviceName,
    stepId,
    previousReportedStepId,
    previousDesired,
    plannedDesiredStepId,
  } = params;
  if (previousDesired?.stepId === stepId) {
    logConfirmed({ log, deviceId, deviceName, stepId, desiredStepId: previousDesired.stepId, previousDesired });
  } else if (plannedDesiredStepId === stepId) {
    logConfirmed({ log, deviceId, deviceName, stepId, desiredStepId: plannedDesiredStepId, previousDesired });
  } else if (plannedDesiredStepId && plannedDesiredStepId !== stepId) {
    logMismatch({ log, deviceId, deviceName, stepId, desiredStepId: plannedDesiredStepId });
  } else if (previousReportedStepId && previousReportedStepId !== stepId) {
    log?.info({
      event: 'stepped_feedback_external_change',
      deviceId,
      deviceName,
      measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      previousStepId: previousReportedStepId,
      newStepId: stepId,
      desiredStepId: previousDesired?.stepId ?? null,
    });
  } else if (previousDesired?.stepId && previousDesired.stepId !== stepId) {
    logMismatch({ log, deviceId, deviceName, stepId, desiredStepId: previousDesired.stepId });
  } else {
    log?.info({
      event: 'stepped_feedback_reported',
      deviceId,
      deviceName,
      measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      reportedStepId: stepId,
    });
  }
}

function logConfirmed(params: {
  log: PinoLogger | undefined;
  deviceId: string;
  deviceName: string;
  stepId: string;
  desiredStepId: string;
  previousDesired: SteppedLoadDesiredRuntimeState | undefined;
}): void {
  params.log?.info({
    event: 'stepped_feedback_confirmed',
    deviceId: params.deviceId,
    deviceName: params.deviceName,
    measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    reportedStepId: params.stepId,
    desiredStepId: params.desiredStepId,
    pending: params.previousDesired?.pending ?? false,
    stale: params.previousDesired?.status === 'stale',
  });
}

function logMismatch(params: {
  log: PinoLogger | undefined;
  deviceId: string;
  deviceName: string;
  stepId: string;
  desiredStepId: string;
}): void {
  params.log?.info({
    event: 'stepped_feedback_mismatch',
    deviceId: params.deviceId,
    deviceName: params.deviceName,
    measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    reportedStepId: params.stepId,
    desiredStepId: params.desiredStepId,
  });
}
