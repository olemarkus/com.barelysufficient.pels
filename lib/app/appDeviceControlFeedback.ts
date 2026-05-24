import type { Logger as PinoLogger } from '../logging/logger';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadDesiredRuntimeState } from './appDeviceControlHelpers';

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
