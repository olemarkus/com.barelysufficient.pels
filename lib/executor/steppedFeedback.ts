import type { Logger as PinoLogger } from '../logging/logger';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID, PELS_TARGET_STEP_CAPABILITY_ID,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadDesiredRuntimeState } from './steppedCommandState';

export function resolvePlannedDesiredStepToPreserve(
  previousDesired: SteppedLoadDesiredRuntimeState | undefined,
  previousDesiredStepId: string | undefined,
  latestPlanDesiredStepId: string | undefined,
  plannedDesiredStepId: string | undefined,
  reportedStepId: string,
): string | undefined {
  if (!plannedDesiredStepId) return undefined;
  if (latestPlanDesiredStepId && previousDesired && previousDesiredStepId !== latestPlanDesiredStepId) {
    return latestPlanDesiredStepId;
  }
  return !previousDesired && plannedDesiredStepId !== reportedStepId ? plannedDesiredStepId : undefined;
}

export function emitSteppedFeedbackLog(
  log: PinoLogger | undefined,
  deviceId: string,
  deviceName: string,
  stepId: string,
  previousReportedStepId: string | undefined,
  previousDesired: SteppedLoadDesiredRuntimeState | undefined,
  plannedDesiredStepId: string | undefined,
): void {
  if (previousDesired?.stepId === stepId) {
    logConfirmed(log, deviceId, deviceName, stepId, previousDesired.stepId, previousDesired);
  } else if (plannedDesiredStepId === stepId) {
    logConfirmed(log, deviceId, deviceName, stepId, plannedDesiredStepId, previousDesired);
  } else if (plannedDesiredStepId && plannedDesiredStepId !== stepId) {
    logMismatch(log, deviceId, deviceName, stepId, plannedDesiredStepId);
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
    logMismatch(log, deviceId, deviceName, stepId, previousDesired.stepId);
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

function logConfirmed(
  log: PinoLogger | undefined, deviceId: string, deviceName: string, stepId: string,
  desiredStepId: string, previousDesired: SteppedLoadDesiredRuntimeState | undefined,
): void {
  log?.info({
    event: 'stepped_feedback_confirmed',
    deviceId: deviceId,
    deviceName: deviceName,
    measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    reportedStepId: stepId,
    desiredStepId: desiredStepId,
    pending: previousDesired?.pending ?? false,
    stale: previousDesired?.status === 'stale',
  });
}

function logMismatch(
  log: PinoLogger | undefined, deviceId: string, deviceName: string, stepId: string, desiredStepId: string,
): void {
  log?.info({
    event: 'stepped_feedback_mismatch',
    deviceId: deviceId,
    deviceName: deviceName,
    measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    reportedStepId: stepId,
    desiredStepId: desiredStepId,
  });
}
