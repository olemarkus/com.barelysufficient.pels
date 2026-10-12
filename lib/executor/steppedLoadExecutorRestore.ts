import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { runBinaryControl, skipRestoreForExternalOffHold } from './binaryControlShared';
import type {
  ExecutableSteppedCommandAttempt,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import { getDebugEmitter, getLogger } from '../logging/logger';
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

export const logSteppedLoadRestoreSkip = (
  intent: ExecutableSteppedLoadIntent,
  reasonCode:
    | 'no_keep_violation'
    | 'waiting_for_confirmation'
    | 'retry_backoff'
    | 'missing_snapshot'
    | 'not_setable'
    | 'already_in_progress'
    | 'recent_binary_restore_attempt',
  desiredStepId?: string,
): false => {
  emitExecutorDebug({
    event: 'restore_command_skipped',
    reasonCode,
    ...(desiredStepId ? { desiredStepId } : {}),
    deviceId: intent.id,
    deviceName: intent.name,
    logContext: 'capacity',
  });
  return false;
};

export const logSteppedLoadStepViolation = (
  action: ExecutableSteppedLoadDevice,
  desiredStepId: string | undefined,
): void => {
  const stepDetail = action.current.stepIsOffStep
    ? `${action.current.stepForShed?.stepId ?? 'unknown'} (off-step)`
    : `${action.current.stepForShed?.stepId ?? 'unknown'} -> ${desiredStepId ?? 'unknown'}`;
  emitExecutorDebug({
    event: 'executor_stepped_log_debug',
    msg: `Capacity: ${action.intent.name} violates keep invariant: step=${stepDetail}`,
  });
};

export const logSteppedLoadRestoreAttemptSkip = (
  intent: ExecutableSteppedLoadIntent,
  attempt: NonNullable<ExecutableSteppedCommandAttempt>,
): false => logSteppedLoadRestoreSkip(
  intent,
  attempt.status === 'awaiting_confirmation' ? 'waiting_for_confirmation' : 'retry_backoff',
  attempt.requestedStepId,
);

export const maybeSkipSteppedLoadRestoreBinary = (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  snapshot: ExecutorDeviceSnapshot | undefined,
  stepNeedsAdjustment: boolean,
): false | null => {
  if (!snapshot) return logSteppedLoadRestoreSkip(intent, 'missing_snapshot');
  if (!ctx.actuator.canTurnOnDevice(intent.id)) return logSteppedLoadRestoreSkip(intent, 'not_setable');
  const snapshotOn = isBinaryOnOrUnknown(snapshot);
  if (ctx.state.actuation.isRestoreInFlight(intent.id)) return logSteppedLoadRestoreSkip(intent, 'already_in_progress');
  if (snapshotOn !== false && !stepNeedsAdjustment) return logSteppedLoadRestoreSkip(intent, 'no_keep_violation');
  return null;
};

// Dispatch the restore binary-on through the same claimed binary seam as every
// other executor path. The snapshot is the producer-resolved command input; the
// shared seam owns pending suppression, cross-clock authority, and transport.
const dispatchSteppedLoadRestoreBinaryCommand = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  snapshot: ExecutorDeviceSnapshot,
): Promise<boolean> => {
  // Dual-control devices (a stepper that also carries a binary handle) are
  // eligible for "Leave off until turned on again", and this lane dispatches a
  // binary ON outside `applyBinaryRestoreWithSnapshot` — so it needs the same
  // carve-out, for the same stale-plan window.
  if (skipRestoreForExternalOffHold(ctx, intent.id, intent.name)) return false;
  const outcome = await runBinaryControl(
    ctx,
    { deviceId: intent.id, name: intent.name, desired: true, logContext: 'capacity' },
    snapshot,
  );
  return outcome.applied;
};

export const executeSteppedLoadRestoreBinary = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  snapshot: ExecutorDeviceSnapshot,
): Promise<boolean> => {
  ctx.state.actuation.beginRestore(intent.id);
  try {
    const applied = await dispatchSteppedLoadRestoreBinaryCommand(ctx, intent, snapshot);
    if (!applied) return false;
    ctx.state.actuation.markSteppedBinaryRestoreAttempt(intent.id, Date.now());
    return true;
  } catch (error) {
    logger.error({
      event: 'executor_stepped_error',
      msg: `Failed to restore stepped-load device ${intent.name} via binary control`,
      err: error,
    });
    return false;
  } finally {
    ctx.state.actuation.endRestore(intent.id);
  }
};

export const applyKeepInvariantShedBlock = (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  hasShedDevices: boolean,
  desiredStepId: string | undefined,
): boolean => {
  if (!hasShedDevices || !desiredStepId) return false;
  const { id, name, steppedLoadProfile } = intent;
  const lowestNonZeroStep = getSteppedLoadLowestActiveStep(steppedLoadProfile);
  const desiredStep = getSteppedLoadStep(steppedLoadProfile, desiredStepId);
  if (!lowestNonZeroStep || !desiredStep || desiredStep.planningPowerW <= lowestNonZeroStep.planningPowerW) {
    return false;
  }
  emitExecutorDebug({
    event: 'executor_stepped_log_debug',
    msg: `Capacity: skip stepped-load restore for ${name}, shed invariant: `
      + `desiredStep=${desiredStepId} exceeds lowestNonZeroStep=${lowestNonZeroStep.id}`,
  });
  const prevBlock = ctx.state.keepInvariantShedBlockedByDevice[id];
  const unchanged = prevBlock !== undefined
    && prevBlock.desiredStepId === desiredStepId
    && prevBlock.lowestNonZeroStepId === lowestNonZeroStep.id;
  if (!unchanged) {
    emitExecutorDebug({
      event: 'restore_keep_invariant_shed_blocked',
      reasonCode: 'shed_invariant',
      deviceId: id,
      deviceName: name,
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      rejectionReason: 'shed_invariant',
    });
    ctx.state.setKeepInvariantShedBlock(id, {
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
    });
  }
  return true;
};
