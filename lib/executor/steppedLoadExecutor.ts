import {
  isBinaryObservedOff,
  isBinaryOnOrUnknown,
} from '../../packages/shared-domain/src/binaryControlState';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { logSteppedLoadRestoreBinaryUndriven } from './steppedLoadRestoreDiagnostics';
import { runBinaryControl } from './binaryControlShared';
import type {
  ExecutableSteppedLoadDevice,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import { getLogger } from '../logging/logger';
import {
  executeSteppedLoadCommand,
  isSteppedLoadStepCommandRedundant,
  logSteppedLoadCommandSkip,
  maybeLogSteppedLoadCommandPendingSkip,
} from './steppedLoadExecutorCommand';
import {
  applyKeepInvariantShedBlock,
  executeSteppedLoadRestoreBinary,
  logSteppedLoadRestoreAttemptSkip,
  logSteppedLoadRestoreSkip,
  logSteppedLoadRestoreViolations,
  maybeSkipSteppedLoadRestoreBinary,
} from './steppedLoadExecutorRestore';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';

export type { PlanExecutorSteppedContext } from './steppedLoadExecutorContext';
import type { PlanExecutorSteppedContext } from './steppedLoadExecutorContext';

const logger = getLogger('executor/stepped-load');

/**
 * Outcome of a stepped-load restore evaluation.
 * - `ready`: the binary is on (or was already on), so the caller may proceed to
 *   issue the step command.
 * - `wroteBinary`: a binary device write was actually dispatched this cycle, so
 *   the caller should count it as an applied device write (drives the
 *   post-actuation refresh).
 */
type SteppedLoadRestoreResult = {
  /** Binary is on (or already was) — the caller may proceed to set the step. */
  ready: boolean;
  /** A binary device write was dispatched this cycle (counts as an applied write). */
  wroteBinary: boolean;
};

const NOT_RESTORED: SteppedLoadRestoreResult = { ready: false, wroteBinary: false };

const resolveCurrentOn = (
  action: ExecutableSteppedLoadDevice,
  snapshot?: ExecutorDeviceSnapshot,
): boolean | null => (snapshot ? isBinaryOnOrUnknown(snapshot) : action.current.on);

const suppressRecentSteppedBinaryRestore = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot | undefined;
    effectiveCurrentOn: boolean | null;
  },
): boolean => {
  const {
    action,
    snapshot,
    effectiveCurrentOn,
  } = params;
  if (
    effectiveCurrentOn !== false
    || !isBinaryObservedOff(snapshot)
    || !ctx.state.hasRecentSteppedBinaryRestoreAttempt(action.id, Date.now())
  ) return false;
  logSteppedLoadRestoreSkip(ctx, {
    action,
    reasonCode: 'recent_binary_restore_attempt',
  });
  return true;
};

const shouldForceSteppedLoadCommand = (options: {
  force?: boolean;
  forceAgainstReleasedOpposing?: boolean;
}): boolean => options.force === true || options.forceAgainstReleasedOpposing === true;

export const applySteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  snapshot?: ExecutorDeviceSnapshot,
  options: {
    recordPlanActuation?: boolean;
    force?: boolean;
    forceAgainstReleasedOpposing?: boolean;
    preserveMaterializedConfirmation?: boolean;
    commandPurpose?: 'post_activation_step';
  } = {},
): Promise<boolean> => {
  // A plan built before an outside OFF can still carry a step-up command. Step
  // commands are real actuation too: suppress every one while the durable hold
  // is active, just as the binary restore funnels do.
  if (ctx.state.isExternalOffHeld?.(action.id) === true) {
    logger.debug({
      event: 'stepped_load_command_skipped',
      deviceId: action.id,
      deviceName: action.name,
      reasonCode: PLAN_REASON_CODES.externalOffHold,
    });
    return false;
  }
  const commandStepId = action.desired.stepId;
  const currentOn = resolveCurrentOn(action, snapshot);
  const forceCommand = shouldForceSteppedLoadCommand(options);
  const initializesUnknownStep = action.transition?.effectiveTransition === 'initialize_unknown_step_at_low';
  if (currentOn === false && action.desired.on === false) return false;
  if (!commandStepId) return false;
  if (!forceCommand && isSteppedLoadStepCommandRedundant(action, commandStepId)) return false;
  const desiredStep = getSteppedLoadStep(action.steppedLoadProfile, commandStepId);
  if (!desiredStep) {
    return logSteppedLoadCommandSkip(ctx, {
      action,
      reasonCode: 'missing_step',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `desired step ${commandStepId} is not in profile`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: action.desired.plannedStepId ?? null },
    });
  }
  if (
    !forceCommand
    && maybeLogSteppedLoadCommandPendingSkip(ctx, action, commandStepId)
  ) return false;
  return executeSteppedLoadCommand(ctx, {
    action,
    options,
    desiredStep,
    transition: action.transition,
    previousStepId: initializesUnknownStep ? undefined : action.previousStepId,
    now: Date.now(),
  });
};

export type ApplySteppedLoadRestoreParams = {
  action: ExecutableSteppedLoadDevice;
  snapshot: ExecutorDeviceSnapshot | undefined;
  hasShedDevices: boolean;
};

export const applySteppedLoadRestore = async (
  ctx: PlanExecutorSteppedContext,
  params: ApplySteppedLoadRestoreParams,
): Promise<SteppedLoadRestoreResult> => {
  const {
    action,
    snapshot,
    hasShedDevices,
  } = params;
  const name = action.name;
  if (action.desired.on !== true) {
    logSteppedLoadRestoreBinaryUndriven(action);
    return NOT_RESTORED;
  }
  const {
    matchingRestoreAttempt,
    stepNeedsAdjustment,
  } = action;
  const effectiveCurrentOn = action.current.on;
  const requestedStepId = action.desired.stepId;
  // Once the device reports on, keep the existing step-command attempt
  // dampening. While it is still off, activation owns the ordering: dispatch
  // binary ON first and immediately reassert the desired step even when an
  // earlier step request was pending or in retry backoff.
  const shouldDeferRestoreForAttempt = stepNeedsAdjustment && matchingRestoreAttempt
    && effectiveCurrentOn === true;
  if (shouldDeferRestoreForAttempt) {
    logSteppedLoadRestoreAttemptSkip(ctx, {
      action,
      matchingRestoreAttempt,
    });
    return NOT_RESTORED;
  }
  logSteppedLoadRestoreViolations(ctx, action, name, {
    desiredStepId: requestedStepId,
    stepNeedsAdjustment,
  });

  if (effectiveCurrentOn === true) {
    if (stepNeedsAdjustment) return NOT_RESTORED;
    logSteppedLoadRestoreSkip(ctx, {
      action,
      reasonCode: 'no_keep_violation',
    });
    return NOT_RESTORED;
  }
  if (isBinaryObservedOff(snapshot)) {
    logger.debug({
      event: 'executor_stepped_log_debug',
      msg: `Capacity: ${name} violates keep invariant: onoff=${isBinaryOnOrUnknown(snapshot)}`,
    });
  }
  if (applyKeepInvariantShedBlock(ctx, action, name, hasShedDevices, requestedStepId)) return NOT_RESTORED;
  ctx.state.clearKeepInvariantShedBlock(action.id);
  if (suppressRecentSteppedBinaryRestore(ctx, {
    action,
    snapshot,
    effectiveCurrentOn,
  })) return { ready: true, wroteBinary: false };
  const binaryRestoreSkip = maybeSkipSteppedLoadRestoreBinary(ctx, {
    action,
    snapshot,
    stepNeedsAdjustment,
  });
  if (binaryRestoreSkip === false) return NOT_RESTORED;
  // `maybeSkipSteppedLoadRestoreBinary` already returns `false` (handled above)
  // when the snapshot is missing, so it is defined here; this guard only narrows
  // the type for the dispatch call below.
  if (!snapshot) return NOT_RESTORED;
  // Binary already on (no write needed) but the restore is "ready" so the caller
  // can proceed to issue the step command.
  if (isBinaryOnOrUnknown(snapshot)) return { ready: true, wroteBinary: false };
  const wroteBinary = await executeSteppedLoadRestoreBinary(ctx, {
    action,
    snapshot,
    name,
  });
  return { ready: wroteBinary, wroteBinary };
};

export const applySteppedLoadShedOff = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: ExecutorDeviceSnapshot | undefined,
): Promise<boolean> => {
  if (action.desired.on !== false) return false;
  const atOffStep = action.current.stepIsOffStep;
  if (action.shedAction !== 'turn_off' && !atOffStep) return false;
  if (!snapshot) return false;
  const name = action.name;
  try {
    const outcome = await runBinaryControl({
      ctx,
      deviceId: action.id,
      name,
      desired: false,
      snapshot,
      logContext: 'capacity',
    });
    if (!outcome.applied) return false;
    return true;
  } catch (error) {
    logger.error({
      event: 'executor_stepped_error',
      msg: `Failed to turn off stepped-load device ${name} via binary control`,
      err: error,
    });
    return false;
  }
};
