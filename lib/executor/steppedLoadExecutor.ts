import { isRequestedStepMaterialized } from './steppedLoadActuation';
import {
  isBinaryObservedOff,
  isBinaryOnOrUnknown,
} from '../../packages/shared-domain/src/binaryControlState';
import { isBinaryDrivenIntent } from './executableDesiredState';
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { SteppedLoadStep } from '../../packages/contracts/src/types';
import { runBinaryControl } from './binaryControlShared';
import type {
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import { getDebugEmitter, getLogger } from '../logging/logger';
import {
  executeSteppedLoadCommand,
  isSteppedLoadStepCommandRedundant,
  logSteppedLoadCommandSkip,
  maybeLogSteppedLoadCommandPendingSkip,
  type SteppedCommandOptions,
} from './steppedLoadExecutorCommand';
import {
  applyKeepInvariantShedBlock,
  executeSteppedLoadRestoreBinary,
  logSteppedLoadRestoreAttemptSkip,
  logSteppedLoadRestoreSkip,
  logSteppedLoadStepViolation,
  maybeSkipSteppedLoadRestoreBinary,
} from './steppedLoadExecutorRestore';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { ExecutorCommandContext } from './executorCommandContext';

const logger = getLogger('executor/stepped-load');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

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
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: ExecutorDeviceSnapshot | undefined,
): boolean => {
  const effectiveCurrentOn = action.current.on;
  if (
    effectiveCurrentOn !== false
    || !isBinaryObservedOff(snapshot)
    || !ctx.state.actuation.hasRecentSteppedBinaryRestoreAttempt(
      action.intent.id, Date.now(), ctx.state.restoreBackoff.restoreCooldownMs,
    )
  ) return false;
  logSteppedLoadRestoreSkip(action.intent, 'recent_binary_restore_attempt');
  return true;
};

/**
 * The device is already where the plan wants it on the binary axis: observed off,
 * and this cycle's decision drives that axis OFF. A step command would be writing
 * to a device the plan wants dark.
 *
 * Absence of the binary cluster is NOT this case — it means the decision does not
 * move the on/off handle at all (the steady / step-up / step-down transitions),
 * where the step command is exactly the point.
 */
const isSettledAtPlannedOff = (
  action: ExecutableSteppedLoadDevice,
  currentOn: boolean | null,
): boolean => currentOn === false && isBinaryDrivenIntent(action.intent) && !action.intent.desiredOn;

export const applySteppedLoadCommand = async (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  snapshot?: ExecutorDeviceSnapshot,
  options: SteppedCommandOptions = {},
): Promise<boolean> => {
  // A plan built before an outside OFF can still carry a step-up command. Step
  // commands are real actuation too: suppress every one while the durable hold
  // is active, just as the binary restore funnels do.
  const { intent } = action;
  if (ctx.state.isExternalOffHeld(intent.id)) {
    emitExecutorDebug({
      event: 'stepped_load_command_skipped',
      deviceId: intent.id,
      deviceName: intent.name,
      reasonCode: PLAN_REASON_CODES.externalOffHold,
    });
    return false;
  }
  const commandStepId = intent.desired.stepId;
  const currentOn = resolveCurrentOn(action, snapshot);
  const forceCommand = options.force === true;
  if (isSettledAtPlannedOff(action, currentOn)) return false;
  if (!commandStepId) return false;
  if (!forceCommand && isSteppedLoadStepCommandRedundant(action, commandStepId)) return false;
  const desiredStep = getSteppedLoadStep(intent.steppedLoadProfile, commandStepId);
  if (!desiredStep) {
    return logSteppedLoadCommandSkip(
      intent,
      'missing_step',
      `Capacity: skip stepped-load command for ${intent.name}, desired step ${commandStepId} is not in profile`,
      { desiredStepId: commandStepId, plannedDesiredStepId: intent.desired.plannedStepId ?? null },
    );
  }
  if (skipsHeldStepRaise(ctx, intent, desiredStep)) return false;
  if (!forceCommand && maybeLogSteppedLoadCommandPendingSkip(intent, commandStepId)) return false;
  return executeSteppedLoadCommand(ctx, action, desiredStep, options);
};

/**
 * A `down_only` command (a step-down under a plan hold) may only lower the
 * device, judged against the observer's record as it stands at the write, not
 * the read this dispatch captured: an earlier device's write can keep the loop
 * waiting while a new report lands. The device must be on and report an active
 * step drawing more than `desiredStep`; otherwise the write is skipped. The
 * command session's reported step is this same record's field, so there is no
 * second report to order against.
 */
const skipsHeldStepRaise = (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  desiredStep: SteppedLoadStep,
): boolean => {
  if (intent.stepDirection !== 'down_only') return false;
  const { steppedLoadProfile: profile } = intent;
  const live = ctx.readDevice(intent.id);
  const liveOn = live !== undefined && isBinaryOnOrUnknown(live);
  const reported = liveOn ? getSteppedLoadStep(profile, live.reportedStepId) : null;
  if (
    reported !== null
    && !isSteppedLoadOffStep(profile, reported.id)
    && desiredStep.planningPowerW < reported.planningPowerW
  ) return false;
  logSteppedLoadCommandSkip(
    intent,
    'not_below_reported_step',
    `Capacity: skip stepped-load command for ${intent.name}, ${desiredStep.id} would not lower its reported step`,
    { desiredStepId: desiredStep.id, reportedStepId: live?.reportedStepId ?? null, observedOn: liveOn },
  );
  return true;
};

export const applySteppedLoadRestore = async (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: ExecutorDeviceSnapshot | undefined,
  hasShedDevices: boolean,
): Promise<SteppedLoadRestoreResult> => {
  const { intent, stepNeedsAdjustment } = action;
  const { name, matchingCommandAttempt } = intent;
  if (!isBinaryDrivenIntent(intent) || !intent.desiredOn) {
    return NOT_RESTORED;
  }
  const effectiveCurrentOn = action.current.on;
  const requestedStepId = intent.desired.stepId;
  // Once the device reports on, keep the existing step-command attempt
  // dampening. While it is still off, activation owns the ordering: dispatch
  // binary ON first and immediately reassert the desired step even when an
  // earlier step request was pending or in retry backoff.
  const shouldDeferRestoreForAttempt = stepNeedsAdjustment && matchingCommandAttempt
    && effectiveCurrentOn === true;
  if (shouldDeferRestoreForAttempt) {
    logSteppedLoadRestoreAttemptSkip(intent, matchingCommandAttempt);
    return NOT_RESTORED;
  }
  if (stepNeedsAdjustment) logSteppedLoadStepViolation(action, requestedStepId);

  if (effectiveCurrentOn === true) {
    if (stepNeedsAdjustment) return NOT_RESTORED;
    logSteppedLoadRestoreSkip(intent, 'no_keep_violation');
    return NOT_RESTORED;
  }
  if (isBinaryObservedOff(snapshot)) {
    emitExecutorDebug({
      event: 'executor_stepped_log_debug',
      msg: `Capacity: ${name} violates keep invariant: onoff=${isBinaryOnOrUnknown(snapshot)}`,
    });
  }
  if (applyKeepInvariantShedBlock(ctx, intent, hasShedDevices, requestedStepId)) return NOT_RESTORED;
  ctx.state.clearKeepInvariantShedBlock(intent.id);
  if (suppressRecentSteppedBinaryRestore(ctx, action, snapshot)) return { ready: true, wroteBinary: false };
  const binaryRestoreSkip = maybeSkipSteppedLoadRestoreBinary(ctx, intent, snapshot, stepNeedsAdjustment);
  if (binaryRestoreSkip === false) return NOT_RESTORED;
  return restorePreparedBinary(ctx, action, snapshot);
};

const restorePreparedBinary = async (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: ExecutorDeviceSnapshot | undefined,
): Promise<SteppedLoadRestoreResult> => {
  const { intent } = action;
  // `maybeSkipSteppedLoadRestoreBinary` already returns `false` (handled above)
  // when the snapshot is missing, so it is defined here; this guard only narrows
  // the type for the dispatch call below.
  if (!snapshot) return NOT_RESTORED;
  // Binary already on (no write needed) but the restore is "ready" so the caller
  // can proceed to issue the step command.
  if (isBinaryOnOrUnknown(snapshot)) return { ready: true, wroteBinary: false };
  if (intent.controlAdapter?.activationOrder === 'current_before_start'
    && !isRequestedStepMaterialized(action.stepActuation)) return NOT_RESTORED;
  const wroteBinary = await executeSteppedLoadRestoreBinary(ctx, intent, snapshot);
  return { ready: wroteBinary, wroteBinary };
};

export const applySteppedLoadShedOff = async (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: ExecutorDeviceSnapshot | undefined,
): Promise<boolean> => {
  const { intent } = action;
  if (!isBinaryDrivenIntent(intent) || intent.desiredOn) return false;
  const atOffStep = action.current.stepIsOffStep;
  // The binary axis is this device's own end state only when the plan decided
  // the device should be off. A plan that wants it parked at a step (or at a
  // setpoint) reaches the binary handle only once the device already sits at its
  // off step — otherwise the step command owns the descent.
  if (intent.plannedShedTarget?.kind !== 'binary_off' && !atOffStep) return false;
  if (!snapshot) return false;
  const name = intent.name;
  try {
    const outcome = await runBinaryControl(
      ctx,
      { deviceId: intent.id, name, desired: false, logContext: 'capacity' },
      snapshot,
    );
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
