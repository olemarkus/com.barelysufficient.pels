import { isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import { getLogger } from '../logging/logger';
import type { ExecutableSteppedLoadDevice } from './executablePlan';
import type { PlanActuationMode } from './executorTypes';

const logger = getLogger('executor/stepped-load-restore-diagnostics');

/**
 * Diagnostic for the "stuck off while cold" incident class (prod: Høiax
 * "Connected 300"): a kept stepped device observed off with a non-off desired
 * step should be turned on, but `desired.on !== true`, so the stepped restore
 * returns silently and no binary `onoff=true` write is issued. The deciding
 * inputs — the resolved transition and its `binaryTarget` — are otherwise
 * invisible in the logs. Emit them so a recurrence pins the trigger. Only fires
 * in the anomalous shape (current observed off + non-off desired step).
 */
export const logSteppedLoadRestoreBinaryUndriven = (
  action: ExecutableSteppedLoadDevice,
  mode: PlanActuationMode,
): void => {
  const desiredStepNonOff = action.desired.stepId !== undefined
    && !isSteppedLoadOffStep(action.steppedLoadProfile, action.desired.stepId);
  if (action.current.on !== false || !desiredStepNonOff) return;
  logger.info({
    event: 'stepped_load_restore_binary_undriven',
    reasonCode: 'desired_on_not_true',
    deviceId: action.id,
    deviceName: action.name,
    desiredOn: action.desired.on ?? null,
    desiredStepId: action.desired.stepId ?? null,
    currentOn: action.current.on,
    currentStepId: action.current.stepId ?? null,
    currentStepIsOffStep: action.current.stepIsOffStep,
    transition: action.transition?.effectiveTransition ?? null,
    binaryTarget: action.transition?.binaryTarget ?? null,
    mode,
  });
};
