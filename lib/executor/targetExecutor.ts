/* eslint-disable max-lines --
 * Extracted target-command actuation keeps one cohesive retry/confirmation
 * pipeline after the executor split.
 */
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { ExecutableTargetCommand, ExecutableTargetUpdate } from './executablePlan';
import {
  getPendingTargetCommandDecision,
  isPendingTargetCommandTemporarilyUnavailable,
  recordFailedPendingTargetCommandAttempt,
  recordPendingTargetCommandAttempt,
} from '../plan/planTargetControl';
import type {
  PendingTargetCommandStatus,
  PendingTargetObservationSource,
} from '../plan/planTypes';
import type { PlanEngineState } from '../plan/planState';
import type { PlanActuationMode } from './executorTypes';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Actuator } from '../actuator/deviceActuator';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/target');

type PlanActionHandleResult = {
  handled: boolean;
  wrote: boolean;
};

type TargetCommandDispatchResult =
  | { applied: false; reason: 'skipped' | 'failed' }
  | { applied: true; attemptType: 'send' | 'retry' };

type TargetCommandPostActuationState = {
  latestObservedValueAfterActuation: unknown;
  pendingStillExists: boolean;
};

export type PlanExecutorTargetContext = {
  state: PlanEngineState;
  deviceManager: {
    getSnapshot: () => TargetDeviceSnapshot[];
    getSnapshotByDeviceId: (deviceId: string) => TargetDeviceSnapshot | undefined;
    setCapability: (deviceId: string, capabilityId: string, value: unknown) => Promise<unknown>;
  };
  /** Single write seam; the setpoint write routes through here (PR1b-2). */
  actuator: Actuator;
  operatingMode: string;
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  logTargetRetryComparison?: (params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }) => Promise<void> | void;
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  recordActivationAttemptStarted: (deviceId: string, name: string, now: number) => void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
};

const waitForImmediateObservedState = async (): Promise<void> => {
  await Promise.resolve();
};

const resolveTargetCommandReasonCode = (params: {
  mode: PlanActuationMode;
  isRestoring: boolean;
  attemptType: 'send' | 'retry';
}): 'reconcile' | 'restore_from_shed' | 'retry_pending_confirmation' | 'plan_update' => {
  const { mode, isRestoring, attemptType } = params;
  if (mode === 'reconcile') return 'reconcile';
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
      actuationMode: 'plan',
    });
    if (!result.applied) return { handled: true, wrote: false };
    logger.info({
      event: 'target_command_applied',
      deviceId: action.deviceId,
      deviceName: action.name,
      capabilityId: action.targetCap,
      targetValue: action.desired,
      previousValue: action.observedValue ?? null,
      mode: 'plan',
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
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (!action) return false;
  return applyTargetUpdatePlan(ctx, action, mode);
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
    const snapshot = ctx.deviceManager.getSnapshotByDeviceId(deviceId);
    const observedValue = snapshot?.targets?.find((entry) => entry.id === targetCap)?.value;
    const result = await dispatchTargetCommand(ctx, {
      deviceId,
      name,
      targetCap,
      desired: shedTemp,
      observedValue,
      skipContext: 'shedding',
      actuationMode: 'plan',
    });
    if (!result.applied) return { handled: result.reason === 'skipped', wrote: false };
    logger.info({
      event: 'target_command_applied',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
      targetValue: shedTemp,
      previousValue: observedValue ?? null,
      mode: 'plan',
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
    actuationMode: PlanActuationMode;
  },
): Promise<TargetCommandDispatchResult> => {
  const {
    deviceId,
    name,
    targetCap,
    desired: rawDesired,
    observedValue,
    skipContext,
    actuationMode,
  } = params;
  const latestObservedSnapshot = ctx.deviceManager.getSnapshotByDeviceId(deviceId);
  const target = latestObservedSnapshot?.targets?.find((entry) => entry.id === targetCap);
  const desired = normalizeTargetCapabilityValue({ target, value: rawDesired });
  const latestObservedValue = latestObservedSnapshot?.targets?.find((entry) => entry.id === targetCap)?.value;
  const preflightResult = handleTargetCommandPreflight(ctx, {
    deviceId,
    name,
    targetCap,
    desired,
    latestObservedValue,
    skipContext,
    actuationMode,
  });
  if (preflightResult.type === 'skip') return preflightResult.result;
  return executeTargetCommandDispatch(ctx, {
    deviceId,
    name,
    targetCap,
    desired,
    observedValue,
    skipContext,
    actuationMode,
    latestObservedValue,
    decisionType: preflightResult.decisionType,
  });
};

const applyTargetUpdatePlan = async (
  ctx: PlanExecutorTargetContext,
  action: ExecutableTargetUpdate,
  mode: PlanActuationMode,
): Promise<boolean> => {
  try {
    const result = await dispatchTargetCommand(ctx, {
      deviceId: action.deviceId,
      name: action.name,
      targetCap: action.targetCap,
      desired: action.desired,
      observedValue: action.observedValue,
      skipContext: 'plan',
      actuationMode: mode,
    });
    if (!result.applied) return false;
    logger.info({
      event: 'target_command_applied',
      deviceId: action.deviceId,
      deviceName: action.name,
      capabilityId: action.targetCap,
      targetValue: action.desired,
      previousValue: action.observedValue ?? null,
      mode,
      attemptType: result.attemptType,
      reasonCode: resolveTargetCommandReasonCode({
        mode,
        isRestoring: action.isRestoring,
        attemptType: result.attemptType,
      }),
      operatingMode: ctx.operatingMode,
    });

    if (action.isRestoring && mode === 'plan') {
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
    actuationMode: PlanActuationMode;
  },
): { type: 'skip'; result: TargetCommandDispatchResult } | { type: 'proceed'; decisionType: 'send' | 'retry' } => {
  const {
    deviceId,
    name,
    targetCap,
    desired,
    latestObservedValue,
    skipContext,
    actuationMode,
  } = params;
  if (Object.is(latestObservedValue, desired)) {
    logger.debug({
      event: 'target_command_skipped',
      reasonCode: 'already_matched',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
      desired,
      observedValue: latestObservedValue ?? null,
      skipContext,
      actuationMode,
    });
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: skip ${targetCap} for ${name}, already ${desired}°C in current snapshot`,
    });
    return { type: 'skip', result: { applied: false, reason: 'skipped' } };
  }
  const nowMs = Date.now();
  const pendingBeforeDecision = ctx.state.pendingTargetCommands[deviceId];
  const canBypassRetryState = actuationMode === 'reconcile'
    && !isPendingTargetCommandTemporarilyUnavailable(pendingBeforeDecision);
  const decision = canBypassRetryState
    ? { type: 'send' as const }
    : getPendingTargetCommandDecision({
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
    actuationMode,
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
    actuationMode: PlanActuationMode;
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
    actuationMode,
    latestObservedValue,
    decisionType,
  } = params;
  const nowMs = Date.now();
  try {
    await ctx.actuator.apply({ kind: 'target', deviceId, capabilityId: targetCap, value: desired });
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
      actuationMode,
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

const syncPendingTargetCommandAfterActuation = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
  },
): Promise<TargetCommandPostActuationState> => {
  const { deviceId, name, targetCap, desired } = params;
  await waitForImmediateObservedState();
  ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
  const latestObservedValueAfterActuation = getLatestObservedTargetValue(ctx, deviceId, targetCap);
  let pendingStillExists = hasMatchingPendingTargetCommand(ctx, deviceId, targetCap, desired);
  if (pendingStillExists && Object.is(latestObservedValueAfterActuation, desired)) {
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
    delete ctx.state.pendingTargetCommands[deviceId];
    pendingStillExists = false;
    ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: confirmed ${targetCap} for ${name} at ${desired}°C immediately after actuation`,
    });
  }
  return {
    latestObservedValueAfterActuation,
    pendingStillExists,
  };
};

const getLatestObservedTargetValue = (
  ctx: PlanExecutorTargetContext,
  deviceId: string,
  targetCap: string,
): unknown => ctx.deviceManager.getSnapshotByDeviceId(deviceId)
  ?.targets?.find((entry) => entry.id === targetCap)
  ?.value;

const hasMatchingPendingTargetCommand = (
  ctx: PlanExecutorTargetContext,
  deviceId: string,
  targetCap: string,
  desired: number,
): boolean => ctx.state.pendingTargetCommands[deviceId]?.capabilityId === targetCap
    && ctx.state.pendingTargetCommands[deviceId]?.desired === desired;

const logPendingTargetRetry = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    retryCount: number;
    retryDelaySec: number;
    observedValue?: unknown;
    observedSource?: PendingTargetObservationSource;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  },
): Promise<void> => {
  const {
    deviceId,
    name,
    targetCap,
    desired,
    retryCount,
    retryDelaySec,
    observedValue,
    observedSource,
    skipContext,
  } = params;
  logger.info({ event: 'executor_target_log', msg: `Target mismatch still present for ${name}; observed `
    + `${formatObservedTarget(observedValue)} `
    + `via ${observedSource ?? 'unknown'}, retrying ${targetCap} to ${desired}°C` });
  logger.debug({ event: 'executor_target_log_debug', msg: `Capacity: retried ${targetCap} for ${name} to ${desired}°C `
    + `(retry ${retryCount}, next retry in ${retryDelaySec}s)` });
  try {
    await ctx.logTargetRetryComparison?.({
      deviceId,
      name,
      targetCap,
      desired,
      observedValue,
      observedSource,
      retryCount,
      skipContext,
    });
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to log target retry comparison for ${name}`,
      err: error,
    });
  }
};

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}
