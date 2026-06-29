import { isBinaryObservedOff, isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { logSteppedLoadRestoreBinaryUndriven } from './steppedLoadRestoreDiagnostics';
import { decideAndDispatchBinaryControl } from './binaryControlDispatch';
import type {
  ExecutableSteppedLoadDevice,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
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

export const applySteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  mode: PlanActuationMode,
  snapshot?: ExecutorDeviceSnapshot,
  options: { recordPlanActuation?: boolean } = {},
): Promise<boolean> => {
  const commandStepId = action.desired.stepId;
  const currentOn = resolveCurrentOn(action, snapshot);
  if (currentOn === false && action.desired.on === false) return false;
  if (!commandStepId) return false;
  if (isSteppedLoadStepCommandRedundant(action, commandStepId)) return false;
  const desiredStep = getSteppedLoadStep(action.steppedLoadProfile, commandStepId);
  if (!desiredStep) {
    return logSteppedLoadCommandSkip(ctx, {
      action,
      mode,
      reasonCode: 'missing_step',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `desired step ${commandStepId} is not in profile`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: action.desired.plannedStepId ?? null },
    });
  }
  if (maybeLogSteppedLoadCommandPendingSkip(ctx, action, mode, commandStepId)) return false;
  return executeSteppedLoadCommand(ctx, {
    action,
    mode,
    options,
    desiredStep,
    transition: action.transition,
    previousStepId: action.previousStepId,
    now: Date.now(),
  });
};

export type ApplySteppedLoadRestoreParams = {
  action: ExecutableSteppedLoadDevice;
  snapshot: ExecutorDeviceSnapshot | undefined;
  mode: PlanActuationMode;
  hasShedDevices: boolean;
  options?: { preRestoreStepIssued?: boolean };
};

export const applySteppedLoadRestore = async (
  ctx: PlanExecutorSteppedContext,
  params: ApplySteppedLoadRestoreParams,
): Promise<SteppedLoadRestoreResult> => {
  const {
    action,
    snapshot,
    mode,
    hasShedDevices,
    options = {},
  } = params;
  const name = action.name;
  if (action.desired.on !== true) {
    logSteppedLoadRestoreBinaryUndriven(action, mode);
    return NOT_RESTORED;
  }
  const {
    stepActuation,
    matchingRestoreAttempt,
    stepNeedsAdjustment,
  } = action;
  const effectiveCurrentOn = action.current.on;
  const requestedStepId = action.desired.stepId;
  // Defer a restore whose step command is still awaiting confirmation while the
  // device already reports on — honouring an explicit `retry_backoff` so the
  // restore cooldown is respected; the binary dispatch keeps its own pending
  // dampener.
  const shouldDeferRestoreForAttempt = stepNeedsAdjustment && matchingRestoreAttempt
    && (effectiveCurrentOn === true
      || matchingRestoreAttempt.status === 'retry_backoff');
  if (shouldDeferRestoreForAttempt) {
    logSteppedLoadRestoreAttemptSkip(ctx, {
      action,
      mode,
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
      mode,
      reasonCode: 'no_keep_violation',
    });
    return NOT_RESTORED;
  }
  const stepViolated = effectiveCurrentOn === false && stepNeedsAdjustment;
  if (isBinaryObservedOff(snapshot)) {
    logger.debug({
      event: 'executor_stepped_log_debug',
      msg: `Capacity: ${name} violates keep invariant: onoff=${isBinaryOnOrUnknown(snapshot)}`,
    });
  }
  if (applyKeepInvariantShedBlock(ctx, action, name, hasShedDevices, requestedStepId)) return NOT_RESTORED;
  // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
  delete ctx.state.keepInvariantShedBlockedByDevice[action.id];
  const binaryRestoreSkip = maybeSkipSteppedLoadRestoreBinary(ctx, {
    action,
    snapshot,
    mode,
    matchingRestoreAttempt,
    stepActuation,
    stepNeedsAdjustment,
    stepViolated,
    desiredStepId: requestedStepId,
    preRestoreStepIssued: options.preRestoreStepIssued,
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
    mode,
    name,
    onoffViolated: isBinaryObservedOff(snapshot),
    stepViolated,
  });
  return { ready: wroteBinary, wroteBinary };
};

export const applySteppedLoadShedOff = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: ExecutorDeviceSnapshot | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (action.desired.on !== false) return false;
  const atOffStep = action.current.stepIsOffStep;
  if (action.shedAction !== 'turn_off' && !atOffStep) return false;
  if (!snapshot) return false;
  const name = action.name;
  try {
    const outcome = await decideAndDispatchBinaryControl({
      transport: ctx.buildBinaryControlTransport(),
      deviceId: action.id,
      name,
      desired: false,
      snapshot,
      logContext: 'capacity',
      actuationMode: mode,
    });
    if (!outcome.applied) return false;
    if (mode === 'plan') {
      const now = Date.now();
      // Intentionally NOT gated on `flowBacked` (unlike the binary direct-write *diagnostic*
      // recorder): this stamps the shed *cooldown*, which must fire regardless of actuation channel.
      ctx.recordShedActuation(action.id, name, now);
    }
    logger.info({
      event: 'binary_command_applied',
      deviceId: action.id,
      deviceName: name,
      capabilityId: snapshot.controlCapabilityId ?? 'onoff',
      desired: false,
      mode,
      reasonCode: mode === 'reconcile' ? 'reconcile_shed' : 'full_shed_to_off',
    });
    logger.info({
      event: 'stepped_load_binary_transition_applied',
      deviceId: action.id,
      deviceName: name,
      desiredBinaryState: false,
      effectiveTransition: 'full_shed_to_off',
      stepPreparationPurpose: atOffStep ? null : 'prepare_for_off',
      transitionPhase: 'binary_transition',
      mode,
      reasonCode: mode === 'reconcile' ? 'reconcile_shed' : 'full_shed_to_off',
    });
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
