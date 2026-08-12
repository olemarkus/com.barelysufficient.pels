import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import type { ExecutableTargetCommand, ExecutableTargetUpdate } from './executablePlan';
import {
  getPendingTargetCommandDecision,
  recordFailedPendingTargetCommandAttempt,
  recordPendingTargetCommandAttempt,
} from '../plan/planTargetControl';
import type { PendingTargetCommandStatus } from '../plan/planTypes';
import { getLogger } from '../logging/logger';
import type { PlanExecutorTargetContext } from './targetExecutorContext';
import {
  logPendingTargetRetry,
  syncPendingTargetCommandAfterActuation,
} from './targetPendingCommand';

// Re-exported so existing importers keep resolving the context type from targetExecutor.
export type { PlanExecutorTargetContext };

const logger = getLogger('executor/target');

type PlanActionHandleResult = {
  handled: boolean;
  wrote: boolean;
};

type TargetCommandDispatchResult =
  | { applied: false; reason: 'skipped' | 'failed' | 'not_requested' }
  | { applied: true; attemptType: 'send' | 'retry' };

const resolveTargetCommandReasonCode = (params: {
  isRestoring: boolean;
  attemptType: 'send' | 'retry';
}): 'restore_from_shed' | 'retry_pending_confirmation' | 'plan_update' => {
  const { isRestoring, attemptType } = params;
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

export const applyShedTemperaturePlan = async (
  ctx: PlanExecutorTargetContext,
  action: ExecutableTargetCommand,
): Promise<PlanActionHandleResult> => {
  try {
    const result = await dispatchTargetCommand(ctx, {
      deviceId: action.deviceId,
      name: action.name,
      targetCap: action.targetCap,
      desired: action.desired,
      observedValue: action.observedValue,
      skipContext: 'shedding',
    });
    if (!result.applied) return { handled: true, wrote: false };
    logger.info({
      event: 'target_command_applied',
      deviceId: action.deviceId,
      deviceName: action.name,
      capabilityId: action.targetCap,
      targetValue: action.desired,
      previousValue: action.observedValue ?? null,
      attemptType: result.attemptType,
      reasonCode: 'shedding',
    });
    const now = Date.now();
    ctx.recordShedActuation(action.deviceId, action.name, now);
    return { handled: true, wrote: true };
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set shed temperature for ${action.name} via DeviceTransport`,
      err: error,
    });
    return { handled: true, wrote: false };
  }
};

export const applyTargetUpdate = async (
  ctx: PlanExecutorTargetContext,
  action: ExecutableTargetUpdate | null,
  options: { forceAgainstReleasedOpposing?: boolean } = {},
): Promise<boolean> => {
  if (!action) return false;
  return applyTargetUpdatePlan(ctx, action, options);
};

export const trySetShedTemperature = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string | undefined;
    shedTemp: number | null;
    canSetShedTemp: boolean;
  },
): Promise<PlanActionHandleResult> => {
  const {
    deviceId,
    name,
    targetCap,
    shedTemp,
    canSetShedTemp,
  } = params;
  if (!canSetShedTemp || !targetCap || shedTemp === null) return { handled: false, wrote: false };
  const now = Date.now();
  try {
    const observedValue = ctx.getObservedState(deviceId)
      ?.targets?.find((entry) => entry.id === targetCap)?.value;
    const result = await dispatchTargetCommand(ctx, {
      deviceId,
      name,
      targetCap,
      desired: shedTemp,
      observedValue,
      skipContext: 'shedding',
    });
    if (!result.applied) return { handled: result.reason === 'skipped', wrote: false };
    logger.info({
      event: 'target_command_applied',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
      targetValue: shedTemp,
      previousValue: observedValue ?? null,
      attemptType: result.attemptType,
      reasonCode: 'shedding',
    });
    ctx.recordShedActuation(deviceId, name, now);
    return { handled: true, wrote: true };
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set shed temperature for ${name} via DeviceTransport`,
      err: error,
    });
    return { handled: false, wrote: false };
  }
};

export const dispatchTargetCommand = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    skipContext: 'plan' | 'shedding' | 'overshoot';
    forceAgainstReleasedOpposing?: boolean;
  },
): Promise<TargetCommandDispatchResult> => {
  const {
    deviceId,
    name,
    targetCap,
    desired: rawDesired,
    observedValue,
    skipContext,
    forceAgainstReleasedOpposing,
  } = params;
  const target = ctx.getObservedState(deviceId)?.targets?.find((entry) => entry.id === targetCap);
  const desired = normalizeTargetCapabilityValue({ target, value: rawDesired });
  const latestObservedValue = target?.value;
  const preflightResult = handleTargetCommandPreflight(ctx, {
    deviceId,
    name,
    targetCap,
    desired,
    latestObservedValue,
    skipContext,
    forceAgainstReleasedOpposing,
  });
  if (preflightResult.type === 'skip') return preflightResult.result;
  if (ctx.targetCommandOwner === 'ordinary' && ctx.isLifecycleFallbackActive?.(deviceId) === true) {
    return { applied: false, reason: 'skipped' };
  }
  if (!ctx.targetCommandClaim.acquire(
    deviceId,
    targetCap,
    ctx.targetCommandOwner,
    desired,
    ctx.onTargetCommandClaimReleased,
  )) {
    return { applied: false, reason: 'skipped' };
  }
  let result: TargetCommandDispatchResult = { applied: false, reason: 'failed' };
  try {
    result = await executeTargetCommandDispatch(ctx, {
      deviceId,
      name,
      targetCap,
      desired,
      observedValue,
      skipContext,
      latestObservedValue,
      decisionType: preflightResult.decisionType,
    });
    return result;
  } finally {
    ctx.targetCommandClaim.release(
      deviceId,
      targetCap,
      ctx.targetCommandOwner,
      desired,
      result.applied,
    );
  }
};

const applyTargetUpdatePlan = async (
  ctx: PlanExecutorTargetContext,
  action: ExecutableTargetUpdate,
  options: { forceAgainstReleasedOpposing?: boolean },
): Promise<boolean> => {
  try {
    const result = await dispatchTargetCommand(ctx, {
      deviceId: action.deviceId,
      name: action.name,
      targetCap: action.targetCap,
      desired: action.desired,
      observedValue: action.observedValue,
      skipContext: 'plan',
      forceAgainstReleasedOpposing: options.forceAgainstReleasedOpposing,
    });
    if (!result.applied) return false;
    logger.info({
      event: 'target_command_applied',
      deviceId: action.deviceId,
      deviceName: action.name,
      capabilityId: action.targetCap,
      targetValue: action.desired,
      previousValue: action.observedValue ?? null,
      attemptType: result.attemptType,
      reasonCode: resolveTargetCommandReasonCode({
        isRestoring: action.isRestoring,
        attemptType: result.attemptType,
      }),
      operatingMode: ctx.operatingMode,
    });

    if (action.isRestoring) {
      const now = Date.now();
      ctx.recordRestoreActuation(action.deviceId, action.name, now);
      ctx.recordActivationAttemptStarted(action.deviceId, action.name, now);
    }
    return true;
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set ${action.targetCap} for ${action.name} via DeviceTransport`,
      err: error,
    });
    return false;
  }
};

const handleTargetCommandPreflight = (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    latestObservedValue: unknown;
    skipContext: 'plan' | 'shedding' | 'overshoot';
    forceAgainstReleasedOpposing?: boolean;
  },
): { type: 'skip'; result: TargetCommandDispatchResult } | { type: 'proceed'; decisionType: 'send' | 'retry' } => {
  const {
    deviceId,
    name,
    targetCap,
    desired,
    latestObservedValue,
    skipContext,
    forceAgainstReleasedOpposing,
  } = params;
  if (forceAgainstReleasedOpposing !== true && Object.is(latestObservedValue, desired)) {
    logger.debug({
      event: 'target_command_skipped',
      reasonCode: 'already_matched',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
      desired,
      observedValue: latestObservedValue ?? null,
      skipContext,
    });
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip ${targetCap} for ${name}, already ${desired}°C in current snapshot`,
    });
    return { type: 'skip', result: { applied: false, reason: 'skipped' } };
  }
  const lifecycleOwnedPending = ctx.getLifecycleOwnedPendingTargetCommand?.(deviceId);
  if (
    lifecycleOwnedPending?.capabilityId === targetCap
    && lifecycleOwnedPending.desired === desired
  ) {
    logger.debug({
      event: 'target_command_skipped',
      reasonCode: 'lifecycle_owned',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
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
    state: ctx.state,
    deviceId,
    capabilityId: targetCap,
    desired,
    nowMs,
  });
  if (decision.type !== 'skip') {
    return { type: 'proceed', decisionType: decision.type };
  }
  const remainingSec = Math.max(1, Math.ceil(decision.remainingMs / 1000));
  logger.debug({
    event: 'target_command_skipped',
    reasonCode: resolveTargetCommandSkipReasonCode(decision.pending.status),
    deviceId,
    deviceName: name,
    capabilityId: targetCap,
    desired,
    retryCount: decision.pending.retryCount,
    remainingMs: decision.remainingMs,
    skipContext,
  });
  if (decision.pending.status === 'temporary_unavailable') {
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip ${targetCap} for ${name}, device temporarily unavailable `
        + `for ${remainingSec}s before retry (${skipContext})`,
    });
  } else {
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip ${targetCap} for ${name}, waiting ${remainingSec}s `
        + `for ${desired}°C confirmation (${skipContext})`,
    });
  }
  return { type: 'skip', result: { applied: false, reason: 'skipped' } };
};

const executeTargetCommandDispatch = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    skipContext: 'plan' | 'shedding' | 'overshoot';
    latestObservedValue: unknown;
    decisionType: 'send' | 'retry';
  },
): Promise<TargetCommandDispatchResult> => {
  const {
    deviceId,
    name,
    targetCap,
    desired,
    observedValue,
    skipContext,
    latestObservedValue,
    decisionType,
  } = params;
  const nowMs = Date.now();
  try {
    const outcome = await ctx.actuator.apply({
      kind: 'target',
      deviceId,
      ...(targetCap.startsWith('target_temperature') ? { targetKind: 'temperature' as const } : {}),
      capabilityId: targetCap,
      value: desired,
    });
    if (!outcome.requested) return { applied: false, reason: 'not_requested' };
    if (ctx.isTargetCommandAuthorityCurrent?.() === false) {
      return { applied: false, reason: 'skipped' };
    }
  } catch (error) {
    const failedPending = recordFailedPendingTargetCommandAttempt({
      state: ctx.state,
      deviceId,
      capabilityId: targetCap,
      desired,
      nowMs,
      observedValue: latestObservedValue ?? observedValue,
    });
    const retryDelaySec = Math.max(1, Math.ceil((failedPending.nextRetryAtMs - nowMs) / 1000));
    logger.error({
      event: 'target_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
      desired,
      skipContext,
    });
    logger.info({
      event: 'executor_target_log',
      msg: `Failed to set ${targetCap} for ${name}; treating device as temporarily unavailable `
        + `for ${retryDelaySec}s before retry`,
    });
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to set ${targetCap} for ${name} via DeviceTransport`,
      err: error,
    });
    return { applied: false, reason: 'failed' };
  }
  const pending = recordPendingTargetCommandAttempt({
    state: ctx.state,
    deviceId,
    capabilityId: targetCap,
    desired,
    nowMs,
    observedValue: latestObservedValue ?? observedValue,
  });
  const {
    latestObservedValueAfterActuation,
    pendingStillExists,
  } = await syncPendingTargetCommandAfterActuation(ctx, {
    deviceId,
    name,
    targetCap,
    desired,
  });
  const retryDelaySec = Math.max(1, Math.ceil((pending.nextRetryAtMs - nowMs) / 1000));
  if (decisionType === 'retry' && pendingStillExists && !Object.is(latestObservedValueAfterActuation, desired)) {
    await logPendingTargetRetry(ctx, {
      deviceId,
      name,
      targetCap,
      desired,
      retryCount: pending.retryCount,
      retryDelaySec,
      observedValue: pending.lastObservedValue,
      observedSource: pending.lastObservedSource,
      skipContext,
    });
  } else if (pendingStillExists) {
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: awaiting ${targetCap} confirmation for ${name} at ${desired}°C `
        + `(next retry in ${retryDelaySec}s)`,
    });
  }
  return {
    applied: true,
    attemptType: decisionType,
  };
};
