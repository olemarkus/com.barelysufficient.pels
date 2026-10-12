import type { ExecutableTargetCommand, ExecutableTargetUpdate } from './executablePlan';
import {
  getPendingTargetCommandDecision,
  recordTargetCommandAttempt,
} from './targetCommandRetry';
import type { PendingTargetCommandStatus } from '../plan/planTypes';
import { getDebugEmitter, getLogger } from '../logging/logger';
import { isHeldByLifecycleLane, type ExecutorCommandContext } from './executorCommandContext';
import {
  logPendingTargetRetry,
  readObservedTemperature,
  syncPendingTargetCommandAfterActuation,
} from './targetPendingCommand';

const logger = getLogger('executor/target');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

type TargetCommandDispatchResult =
  | { applied: false; reason: 'skipped' | 'failed' | 'not_requested' }
  | { applied: true; attemptType: 'send' | 'retry'; requestedValue: number };

type TargetSkipContext = 'plan' | 'shedding';

const resolveTargetCommandReasonCode = (
  isRestoring: boolean,
  attemptType: 'send' | 'retry',
): 'restore_from_shed' | 'retry_pending_confirmation' | 'plan_update' => {
  if (isRestoring) return 'restore_from_shed';
  if (attemptType === 'retry') return 'retry_pending_confirmation';
  return 'plan_update';
};

const resolveTargetCommandSkipReasonCode = (
  pendingStatus: PendingTargetCommandStatus,
): 'temporarily_unavailable' | 'waiting_for_confirmation' => (
  pendingStatus === 'temporary_unavailable'
    ? 'temporarily_unavailable'
    : 'waiting_for_confirmation'
);

/** Write a plan's shed setpoint; `true` when the write went out. */
export const applyShedTemperaturePlan = async (
  ctx: ExecutorCommandContext,
  command: ExecutableTargetCommand,
): Promise<boolean> => {
  try {
    const result = await dispatchTargetCommand(ctx, command, 'shedding');
    if (!result.applied) return false;
    logger.info({
      event: 'target_command_applied',
      deviceId: command.deviceId,
      deviceName: command.name,
      target: 'temperature',
      targetValue: result.requestedValue,
      previousValue: command.observedValue ?? null,
      attemptType: result.attemptType,
      reasonCode: 'shedding',
    });
    ctx.recordShedActuation(command.deviceId, command.name, Date.now());
    return true;
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set shed temperature for ${command.name} via DeviceTransport`,
      err: error,
    });
    return false;
  }
};

export const applyTargetUpdate = async (
  ctx: ExecutorCommandContext,
  update: ExecutableTargetUpdate,
  forceAgainstReleasedOpposing = false,
): Promise<boolean> => {
  try {
    const result = await dispatchTargetCommand(ctx, update, 'plan', forceAgainstReleasedOpposing);
    if (!result.applied) return false;
    logger.info({
      event: 'target_command_applied',
      deviceId: update.deviceId,
      deviceName: update.name,
      target: 'temperature',
      targetValue: result.requestedValue,
      previousValue: update.observedValue ?? null,
      attemptType: result.attemptType,
      reasonCode: resolveTargetCommandReasonCode(update.isRestoring, result.attemptType),
      operatingMode: ctx.getOperatingMode(),
    });

    if (update.isRestoring) {
      const now = Date.now();
      ctx.recordRestoreActuation(update.deviceId, update.name, now);
      ctx.recordActivationAttemptStarted(update.deviceId, update.name, now);
    }
    return true;
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set temperature for ${update.name} via DeviceTransport`,
      err: error,
    });
    return false;
  }
};

export const dispatchTargetCommand = async (
  ctx: ExecutorCommandContext,
  command: ExecutableTargetCommand,
  skipContext: TargetSkipContext,
  forceAgainstReleasedOpposing = false,
): Promise<TargetCommandDispatchResult> => {
  const { deviceId } = command;
  const resolved: ExecutableTargetCommand = {
    ...command,
    desired: ctx.actuator.resolveTemperatureTarget(deviceId, command.desired),
  };
  const latestObservedValue = readObservedTemperature(ctx, deviceId);
  const preflightResult = handleTargetCommandPreflight(
    ctx, resolved, latestObservedValue, skipContext, forceAgainstReleasedOpposing,
  );
  if (preflightResult.type === 'skip') return preflightResult.result;
  if (isHeldByLifecycleLane(ctx, deviceId)) {
    return { applied: false, reason: 'skipped' };
  }
  if (!ctx.targetCommandClaim.acquire(
    deviceId,
    ctx.owner,
    resolved.desired,
    ctx.onTargetCommandClaimReleased,
  )) {
    return { applied: false, reason: 'skipped' };
  }
  let result: TargetCommandDispatchResult = { applied: false, reason: 'failed' };
  try {
    result = await executeTargetCommandDispatch(
      ctx, resolved, latestObservedValue, skipContext, preflightResult.decisionType,
    );
    return result;
  } finally {
    ctx.targetCommandClaim.release(
      deviceId,
      ctx.owner,
      resolved.desired,
      result.applied,
    );
  }
};

const handleTargetCommandPreflight = (
  ctx: ExecutorCommandContext,
  command: ExecutableTargetCommand,
  latestObservedValue: unknown,
  skipContext: TargetSkipContext,
  forceAgainstReleasedOpposing: boolean,
): { type: 'skip'; result: TargetCommandDispatchResult } | { type: 'proceed'; decisionType: 'send' | 'retry' } => {
  const { deviceId, name, desired } = command;
  if (!forceAgainstReleasedOpposing && Object.is(latestObservedValue, desired)) {
    emitExecutorDebug({
      event: 'target_command_skipped',
      reasonCode: 'already_matched',
      deviceId,
      deviceName: name,
      target: 'temperature',
      desired,
      observedValue: latestObservedValue ?? null,
      skipContext,
    });
    emitExecutorDebug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip temperature for ${name}, already ${desired}°C in current snapshot`,
    });
    return { type: 'skip', result: { applied: false, reason: 'skipped' } };
  }
  // The lifecycle lane's own claim on this command suppresses an ordinary
  // write; the lifecycle lane never stands down to itself.
  const lifecycleOwnedPending = ctx.owner === 'ordinary'
    ? ctx.lifecycleFallback.getOwnedTargetPending(deviceId)
    : undefined;
  if (lifecycleOwnedPending?.desired === desired) {
    emitExecutorDebug({
      event: 'target_command_skipped',
      reasonCode: 'lifecycle_owned',
      deviceId,
      deviceName: name,
      target: 'temperature',
      desired,
      retryCount: lifecycleOwnedPending.retryCount,
      skipContext,
    });
    return { type: 'skip', result: { applied: false, reason: 'skipped' } };
  }
  const nowMs = Date.now();
  // Retry suppression is now unconditional. The reconcile lane used to bypass it
  // (a re-assert had no pending-command bookkeeping of its own), which is half of
  // how a re-assert could outrun the planner in inc_26449fb9.
  const decision = getPendingTargetCommandDecision({
    state: ctx.targetCommands,
    deviceId,
    desired,
    nowMs,
  });
  if (decision.type !== 'skip') {
    return { type: 'proceed', decisionType: decision.type };
  }
  const remainingSec = Math.max(1, Math.ceil(decision.remainingMs / 1000));
  emitExecutorDebug({
    event: 'target_command_skipped',
    reasonCode: resolveTargetCommandSkipReasonCode(decision.pending.status),
    deviceId,
    deviceName: name,
    target: 'temperature',
    desired,
    retryCount: decision.pending.retryCount,
    remainingMs: decision.remainingMs,
    skipContext,
  });
  if (decision.pending.status === 'temporary_unavailable') {
    emitExecutorDebug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip temperature for ${name}, device temporarily unavailable `
        + `for ${remainingSec}s before retry (${skipContext})`,
    });
  } else {
    emitExecutorDebug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip temperature for ${name}, waiting ${remainingSec}s `
        + `for ${desired}°C confirmation (${skipContext})`,
    });
  }
  return { type: 'skip', result: { applied: false, reason: 'skipped' } };
};

const executeTargetCommandDispatch = async (
  ctx: ExecutorCommandContext,
  command: ExecutableTargetCommand,
  latestObservedValue: unknown,
  skipContext: TargetSkipContext,
  decisionType: 'send' | 'retry',
): Promise<TargetCommandDispatchResult> => {
  const { deviceId, name, desired, observedValue } = command;
  const nowMs = Date.now();
  try {
    const outcome = await ctx.actuator.apply({
      kind: 'target',
      deviceId,
      target: 'temperature',
      value: desired,
    });
    if (!outcome.requested) return { applied: false, reason: 'not_requested' };
    if (outcome.kind !== 'target') {
      throw new Error(`Target actuator returned ${outcome.kind} outcome for ${deviceId}`);
    }
    if (!ctx.isAuthorityCurrent()) {
      return { applied: false, reason: 'skipped' };
    }
    const requestedValue = outcome.requestedTargetValue;
    const pending = recordTargetCommandAttempt(
      ctx.targetCommands, deviceId, requestedValue, nowMs, 'waiting_confirmation', latestObservedValue ?? observedValue,
    );
    const {
      latestObservedValueAfterActuation,
      pendingStillExists,
    } = await syncPendingTargetCommandAfterActuation(ctx, { ...command, desired: requestedValue });
    const retryDelaySec = Math.max(1, Math.ceil((pending.nextRetryAtMs - nowMs) / 1000));
    if (
      decisionType === 'retry'
      && pendingStillExists
      && !Object.is(latestObservedValueAfterActuation, requestedValue)
    ) {
      logPendingTargetRetry(name, pending, retryDelaySec);
    } else if (pendingStillExists) {
      emitExecutorDebug({
        event: 'executor_target_log_debug',
        msg: `Capacity: awaiting temperature confirmation for ${name} at ${requestedValue}°C `
          + `(next retry in ${retryDelaySec}s)`,
      });
    }
    return { applied: true, attemptType: decisionType, requestedValue };
  } catch (error) {
    const failedPending = recordTargetCommandAttempt(
      ctx.targetCommands, deviceId, desired, nowMs, 'temporary_unavailable', latestObservedValue ?? observedValue,
    );
    const retryDelaySec = Math.max(1, Math.ceil((failedPending.nextRetryAtMs - nowMs) / 1000));
    logger.error({
      event: 'target_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId,
      deviceName: name,
      target: 'temperature',
      desired,
      skipContext,
    });
    logger.info({
      event: 'executor_target_log',
      msg: `Failed to set temperature for ${name}; treating device as temporarily unavailable `
        + `for ${retryDelaySec}s before retry`,
    });
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set temperature for ${name} via DeviceTransport`,
      err: error,
    });
    return { applied: false, reason: 'failed' };
  }
};
