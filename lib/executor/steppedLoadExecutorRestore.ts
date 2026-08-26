import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import { canTurnOnDevice } from '../plan/deviceCommandability';
import { runBinaryControl, skipRestoreForExternalOffHold } from './binaryControlShared';
import type {
  ExecutableSteppedLoadDevice,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import { getLogger } from '../logging/logger';
import type { PlanExecutorSteppedContext } from './steppedLoadExecutorContext';

const logger = getLogger('executor/stepped-load');

export const logSteppedLoadRestoreSkip = (
  _ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    reasonCode:
      | 'no_keep_violation'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'missing_snapshot'
      | 'not_setable'
      | 'already_in_progress'
      | 'recent_binary_restore_attempt';
    desiredStepId?: string;
  },
): false => {
  const {
    action,
    reasonCode,
    desiredStepId,
  } = params;
  logger.debug({
    event: 'restore_command_skipped',
    reasonCode,
    ...(desiredStepId ? { desiredStepId } : {}),
    deviceId: action.id,
    deviceName: action.name,
    logContext: 'capacity',
  });
  return false;
};

const logSteppedLoadStepViolation = (
  _ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  name: string,
  desiredStepId?: string,
): void => {
  const stepDetail = action.current.stepIsOffStep
    ? `${action.current.stepForShed?.stepId ?? 'unknown'} (off-step)`
    : `${action.current.stepForShed?.stepId ?? 'unknown'} -> ${desiredStepId ?? 'unknown'}`;
  logger.debug({
    event: 'executor_stepped_log_debug',
    msg: `Capacity: ${name} violates keep invariant: step=${stepDetail}`,
  });
};

export const logSteppedLoadRestoreViolations = (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  name: string,
  params: {
    desiredStepId?: string;
    stepNeedsAdjustment: boolean;
  },
): void => {
  const { desiredStepId, stepNeedsAdjustment } = params;
  if (stepNeedsAdjustment) {
    logSteppedLoadStepViolation(ctx, action, name, desiredStepId);
  }
};

export const logSteppedLoadRestoreAttemptSkip = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    matchingRestoreAttempt: NonNullable<ExecutableSteppedLoadDevice['matchingRestoreAttempt']>;
  },
): false => {
  const {
    action,
    matchingRestoreAttempt,
  } = params;
  return logSteppedLoadRestoreSkip(ctx, {
    action,
    reasonCode: matchingRestoreAttempt.status === 'awaiting_confirmation'
      ? 'waiting_for_confirmation'
      : 'retry_backoff',
    desiredStepId: matchingRestoreAttempt.requestedStepId,
  });
};

export const maybeSkipSteppedLoadRestoreBinary = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot | undefined;
    stepNeedsAdjustment: boolean;
  },
): false | null => {
  const {
    action,
    snapshot,
    stepNeedsAdjustment,
  } = params;
  if (!snapshot) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      reasonCode: 'missing_snapshot',
    });
  }
  if (!canTurnOnDevice(snapshot)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      reasonCode: 'not_setable',
    });
  }
  const snapshotOn = isBinaryOnOrUnknown(snapshot);
  if (ctx.state.pendingRestores.has(action.id)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      reasonCode: 'already_in_progress',
    });
  }
  if (snapshotOn !== false && !stepNeedsAdjustment) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      reasonCode: 'no_keep_violation',
    });
  }
  return null;
};

// Dispatch the restore binary-on through the same claimed binary seam as every
// other executor path. The snapshot is the producer-resolved command input; the
// shared seam owns pending suppression, cross-clock authority, and transport.
const dispatchSteppedLoadRestoreBinaryCommand = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot;
    name: string;
  },
): Promise<boolean> => {
  const { action, snapshot, name } = params;
  // Dual-control devices (a stepper that also carries a binary handle) are
  // eligible for "Leave off until turned on again", and this lane dispatches a
  // binary ON outside `applyBinaryRestoreWithSnapshot` — so it needs the same
  // carve-out, for the same stale-plan window.
  if (skipRestoreForExternalOffHold(ctx, action.id, name)) return false;
  const outcome = await runBinaryControl({
    ctx,
    deviceId: action.id,
    name,
    desired: true,
    snapshot,
    logContext: 'capacity',
    restoreSource: ctx.getRestoreLogSource(action.id),
  });
  return outcome.applied;
};

export const executeSteppedLoadRestoreBinary = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot;
    name: string;
  },
): Promise<boolean> => {
  const {
    action,
    snapshot,
    name,
  } = params;
  ctx.state.pendingRestores.add(action.id);
  try {
    const applied = await dispatchSteppedLoadRestoreBinaryCommand(ctx, {
      action,
      snapshot,
      name,
    });
    if (!applied) return false;
    ctx.state.markSteppedBinaryRestoreAttempt(action.id, Date.now());
    return true;
  } catch (error) {
    logger.error({
      event: 'executor_stepped_error',
      msg: `Failed to restore stepped-load device ${name} via binary control`,
      err: error,
    });
    return false;
  } finally {
    ctx.state.pendingRestores.delete(action.id);
  }
};

export const applyKeepInvariantShedBlock = (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  name: string,
  hasShedDevices: boolean,
  desiredStepId?: string,
): boolean => {
  if (!hasShedDevices || !desiredStepId) return false;
  const lowestNonZeroStep = getSteppedLoadLowestActiveStep(action.steppedLoadProfile);
  const desiredStep = getSteppedLoadStep(action.steppedLoadProfile, desiredStepId);
  if (!lowestNonZeroStep || !desiredStep || desiredStep.planningPowerW <= lowestNonZeroStep.planningPowerW) {
    return false;
  }
  logger.debug({
    event: 'executor_stepped_log_debug',
    msg: `Capacity: skip stepped-load restore for ${name}, shed invariant: `
      + `desiredStep=${desiredStepId} exceeds lowestNonZeroStep=${lowestNonZeroStep.id}`,
  });
  const prevBlock = ctx.state.keepInvariantShedBlockedByDevice[action.id];
  const unchanged = prevBlock !== undefined
    && prevBlock.desiredStepId === desiredStepId
    && prevBlock.lowestNonZeroStepId === lowestNonZeroStep.id;
  if (!unchanged) {
    logger.debug({
      event: 'restore_keep_invariant_shed_blocked',
      reasonCode: 'shed_invariant',
      deviceId: action.id,
      deviceName: name,
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      rejectionReason: 'shed_invariant',
    });
    ctx.state.setKeepInvariantShedBlock(action.id, {
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
    });
  }
  return true;
};
