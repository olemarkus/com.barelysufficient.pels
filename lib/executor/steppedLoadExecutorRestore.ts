import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
  recordActivationSetbackForDevice,
} from '../plan/planExecutorSupport';
import { decideAndDispatchBinaryControl } from './binaryControlDispatch';
import {
  isRequestedStepMaterialized,
  type SteppedStepActuationState,
} from './steppedLoadActuation';
import type {
  ExecutableSteppedLoadDevice,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
import { getLogger } from '../logging/logger';
import type { PlanExecutorSteppedContext } from './steppedLoadExecutorContext';

const logger = getLogger('executor/stepped-load');

export const logSteppedLoadRestoreSkip = (
  _ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    mode: PlanActuationMode;
    reasonCode:
      | 'no_keep_violation'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'missing_snapshot'
      | 'not_setable'
      | 'already_in_progress'
      | 'pre_restore_step_required';
    skipDetailCode?:
      | 'pre_restore_step_pending_confirmation'
      | 'pre_restore_step_command_not_issued';
    desiredStepId?: string;
  },
): false => {
  const {
    action,
    mode,
    reasonCode,
    skipDetailCode,
    desiredStepId,
  } = params;
  logger.debug({
    event: 'restore_command_skipped',
    reasonCode,
    ...(skipDetailCode ? { skipDetailCode } : {}),
    ...(desiredStepId ? { desiredStepId } : {}),
    deviceId: action.id,
    deviceName: action.name,
    logContext: 'capacity',
    actuationMode: mode,
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
    mode: PlanActuationMode;
    matchingRestoreAttempt: NonNullable<ExecutableSteppedLoadDevice['matchingRestoreAttempt']>;
  },
): false => {
  const {
    action,
    mode,
    matchingRestoreAttempt,
  } = params;
  return logSteppedLoadRestoreSkip(ctx, {
    action,
    mode,
    reasonCode: matchingRestoreAttempt.status === 'awaiting_confirmation'
      ? 'waiting_for_confirmation'
      : 'retry_backoff',
    desiredStepId: matchingRestoreAttempt.requestedStepId,
  });
};

const isStepMaterializationPending = (state: SteppedStepActuationState): boolean => (
  state.materialization.kind === 'not_materialized'
  && state.materialization.reason === 'fallback_only'
);

export const maybeSkipSteppedLoadRestoreBinary = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot | undefined;
    mode: PlanActuationMode;
    matchingRestoreAttempt: ExecutableSteppedLoadDevice['matchingRestoreAttempt'];
    stepActuation: SteppedStepActuationState;
    stepNeedsAdjustment: boolean;
    stepViolated: boolean;
    desiredStepId?: string;
    preRestoreStepIssued?: boolean;
  },
): false | null => {
  const {
    action,
    snapshot,
    mode,
    matchingRestoreAttempt,
    stepActuation,
    stepNeedsAdjustment,
    stepViolated,
    desiredStepId,
    preRestoreStepIssued,
  } = params;
  if (!snapshot) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'missing_snapshot',
    });
  }
  if (!canTurnOnDevice(snapshot)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'not_setable',
    });
  }
  const snapshotOn = isBinaryOnOrUnknown(snapshot);
  if (ctx.state.pendingRestores.has(action.id)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'already_in_progress',
    });
  }
  if (
    snapshotOn === false
    && stepViolated
    && !isRequestedStepMaterialized(stepActuation)
  ) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'pre_restore_step_required',
      skipDetailCode: preRestoreStepIssued === true
        || matchingRestoreAttempt?.status === 'awaiting_confirmation'
        || isStepMaterializationPending(stepActuation)
        ? 'pre_restore_step_pending_confirmation'
        : 'pre_restore_step_command_not_issued',
      desiredStepId,
    });
  }
  if (snapshotOn !== false && !stepNeedsAdjustment) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'no_keep_violation',
    });
  }
  return null;
};

// Dispatch the restore binary-on. With a trusted observation we go through the
// normal decide-and-dispatch path. When the observation is unknown the device's
// `currentOn` is the producer's optimistic default, which would make
// `decideBinaryControl`'s already-matched gate (it reads `currentOn === desired`)
// suppress the command forever. We must not change that plan-layer gate, so for
// the unknown case we build the decision here and dispatch it directly — keeping
// decide's legitimate guards (control-plan presence, `canSet`, and the
// pending-command dampener) and dropping only the optimistic already-matched skip.
const dispatchSteppedLoadRestoreBinaryCommand = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot;
    mode: PlanActuationMode;
    name: string;
  },
): Promise<boolean> => {
  const { action, snapshot, mode, name } = params;
  const outcome = await decideAndDispatchBinaryControl({
    transport: ctx.buildBinaryControlTransport(),
    deviceId: action.id,
    name,
    desired: true,
    snapshot,
    logContext: 'capacity',
    restoreSource: ctx.getRestoreLogSource(action.id),
    actuationMode: mode,
  });
  return outcome.applied;
};

export const executeSteppedLoadRestoreBinary = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: ExecutorDeviceSnapshot;
    mode: PlanActuationMode;
    name: string;
    onoffViolated: boolean;
    stepViolated: boolean;
  },
): Promise<boolean> => {
  const {
    action,
    snapshot,
    mode,
    name,
    onoffViolated,
    stepViolated,
  } = params;
  ctx.state.pendingRestores.add(action.id);
  try {
    const applied = await dispatchSteppedLoadRestoreBinaryCommand(ctx, {
      action,
      snapshot,
      mode,
      name,
    });
    if (!applied) return false;
    logger.info({
      event: 'stepped_load_binary_transition_applied',
      deviceId: action.id,
      deviceName: name,
      desiredBinaryState: true,
      effectiveTransition: 'restore_from_off_at_low',
      stepPreparationPurpose: stepViolated ? 'prepare_for_on' : null,
      transitionPhase: 'binary_transition',
      mode,
      onoffViolated,
      stepViolated,
      reasonCode: 'keep_invariant',
    });
    if (mode === 'plan') {
      const now = Date.now();
      // Intentionally NOT gated on `flowBacked` (unlike the binary direct-write *diagnostic*
      // recorder): this stamps the restore *cooldown*, which must fire regardless of actuation channel.
      ctx.recordRestoreActuation(action.id, name, now);
      recordActivationAttemptStarted({
        state: ctx.state,
        diagnostics: ctx.deviceDiagnostics,
        deviceId: action.id,
        name,
        nowTs: now,
      });
    } else if (mode === 'reconcile') {
      recordActivationSetbackForDevice({
        state: ctx.state,
        diagnostics: ctx.deviceDiagnostics,
        deviceId: action.id,
        name,
        nowTs: Date.now(),
      });
    }
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
