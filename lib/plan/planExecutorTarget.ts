/* eslint-disable max-lines --
 * Extracted target-command actuation keeps one cohesive retry/confirmation
 * pipeline after the executor split.
 */
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import type { TargetDeviceSnapshot } from '../utils/types';
import {
  getPendingTargetCommandDecision,
  isPendingTargetCommandTemporarilyUnavailable,
  recordFailedPendingTargetCommandAttempt,
  recordPendingTargetCommandAttempt,
} from './planTargetControl';
import type {
  DevicePlan,
  PendingTargetCommandStatus,
  PendingTargetObservationSource,
  ShedAction,
} from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanActuationMode } from './planExecutor';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { StructuredDebugEmitter } from '../logging/logger';

type PlanDevice = DevicePlan['devices'][number];

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
    setCapability: (deviceId: string, capabilityId: string, value: unknown) => Promise<unknown>;
  };
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
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
  structuredLog?: {
    info: (obj: object) => void;
    error: (obj: object) => void;
  };
  debugStructured?: StructuredDebugEmitter;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
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
  dev: PlanDevice,
  targetCap: string,
  plannedTarget: number,
): Promise<PlanActionHandleResult> => {
  try {
    const result = await dispatchTargetCommand(ctx, {
      deviceId: dev.id,
      name: dev.name,
      targetCap,
      desired: plannedTarget,
      observedValue: dev.currentTarget,
      skipContext: 'shedding',
      actuationMode: 'plan',
    });
    if (!result.applied) return { handled: true, wrote: false };
    ctx.structuredLog?.info({
      event: 'target_command_applied',
      deviceId: dev.id,
      deviceName: dev.name,
      capabilityId: targetCap,
      targetValue: plannedTarget,
      previousValue: dev.currentTarget ?? null,
      mode: 'plan',
      attemptType: result.attemptType,
      reasonCode: 'shedding',
    });
    const now = Date.now();
    ctx.recordShedActuation(dev.id, dev.name, now);
    return { handled: true, wrote: true };
  } catch (error) {
    ctx.error(`Failed to set shed temperature for ${dev.name} via DeviceManager`, error);
    return { handled: true, wrote: false };
  }
};

export const applyTargetUpdate = async (
  ctx: PlanExecutorTargetContext,
  dev: PlanDevice,
  snapshot: TargetDeviceSnapshot | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  const plan = getTargetUpdatePlan(ctx, dev, snapshot);
  if (!plan) return false;
  return applyTargetUpdatePlan(ctx, dev, plan.targetCap, plan.isRestoring, mode);
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
    const snapshot = ctx.deviceManager.getSnapshot().find((entry) => entry.id === deviceId);
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
    ctx.structuredLog?.info({
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
    ctx.error(`Failed to set shed temperature for ${name} via DeviceManager`, error);
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
  const latestObservedSnapshot = ctx.deviceManager.getSnapshot().find((entry) => entry.id === deviceId);
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

const getTargetUpdatePlan = (
  ctx: PlanExecutorTargetContext,
  dev: PlanDevice,
  snapshot?: TargetDeviceSnapshot,
): { targetCap: string; isRestoring: boolean } | null => {
  if (typeof dev.plannedTarget !== 'number' || dev.plannedTarget === dev.currentTarget) return null;
  const entry = snapshot ?? ctx.deviceManager.getSnapshot().find((d) => d.id === dev.id);
  const targetCap = entry?.targets?.[0]?.id;
  if (!targetCap) return null;

  const currentIsNumber = typeof dev.currentTarget === 'number';
  const shedBehavior = ctx.getShedBehavior(dev.id);
  const wasAtShedTemp = currentIsNumber && shedBehavior.action === 'set_temperature'
    && shedBehavior.temperature !== null && dev.currentTarget === shedBehavior.temperature;
  const isRestoring = wasAtShedTemp && dev.plannedTarget > (dev.currentTarget as number);
  return { targetCap, isRestoring };
};

const applyTargetUpdatePlan = async (
  ctx: PlanExecutorTargetContext,
  dev: PlanDevice,
  targetCap: string,
  isRestoring: boolean,
  mode: PlanActuationMode,
): Promise<boolean> => {
  try {
    const result = await dispatchTargetCommand(ctx, {
      deviceId: dev.id,
      name: dev.name,
      targetCap,
      desired: dev.plannedTarget as number,
      observedValue: dev.currentTarget,
      skipContext: 'plan',
      actuationMode: mode,
    });
    const name = dev.name;
    if (!result.applied) return false;
    ctx.structuredLog?.info({
      event: 'target_command_applied',
      deviceId: dev.id,
      deviceName: name,
      capabilityId: targetCap,
      targetValue: dev.plannedTarget as number,
      previousValue: dev.currentTarget ?? null,
      mode,
      attemptType: result.attemptType,
      reasonCode: resolveTargetCommandReasonCode({ mode, isRestoring, attemptType: result.attemptType }),
      operatingMode: ctx.operatingMode,
    });

    if (isRestoring && mode === 'plan') {
      const now = Date.now();
      ctx.recordRestoreActuation(dev.id, dev.name, now);
      ctx.recordActivationAttemptStarted(dev.id, dev.name, now);
    }
    return true;
  } catch (error) {
    ctx.error(`Failed to set ${targetCap} for ${dev.name} via DeviceManager`, error);
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
    ctx.debugStructured?.({
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
    ctx.logDebug(`Capacity: skip ${targetCap} for ${name}, already ${desired}°C in current snapshot`);
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
  ctx.debugStructured?.({
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
    ctx.logDebug(
      `Capacity: skip ${targetCap} for ${name}, device temporarily unavailable `
      + `for ${remainingSec}s before retry (${skipContext})`,
    );
  } else {
    ctx.logDebug(
      `Capacity: skip ${targetCap} for ${name}, waiting ${remainingSec}s `
      + `for ${desired}°C confirmation (${skipContext})`,
    );
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
    await ctx.deviceManager.setCapability(deviceId, targetCap, desired);
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
    ctx.structuredLog?.error({
      event: 'target_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId,
      deviceName: name,
      capabilityId: targetCap,
      desired,
      skipContext,
      actuationMode,
    });
    ctx.log(
      `Failed to set ${targetCap} for ${name}; treating device as temporarily unavailable `
      + `for ${retryDelaySec}s before retry`,
    );
    ctx.error(`Failed to set ${targetCap} for ${name} via DeviceManager`, error);
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
    ctx.logDebug(
      `Capacity: awaiting ${targetCap} confirmation for ${name} at ${desired}°C `
      + `(next retry in ${retryDelaySec}s)`,
    );
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
    // eslint-disable-next-line no-param-reassign -- Shared executor state update.
    delete ctx.state.pendingTargetCommands[deviceId];
    pendingStillExists = false;
    ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
    ctx.logDebug(`Capacity: confirmed ${targetCap} for ${name} at ${desired}°C immediately after actuation`);
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
): unknown => ctx.deviceManager.getSnapshot()
  .find((entry) => entry.id === deviceId)
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
  ctx.log(
    `Target mismatch still present for ${name}; observed `
    + `${formatObservedTarget(observedValue)} `
    + `via ${observedSource ?? 'unknown'}, retrying ${targetCap} to ${desired}°C`,
  );
  ctx.logDebug(
    `Capacity: retried ${targetCap} for ${name} to ${desired}°C `
    + `(retry ${retryCount}, next retry in ${retryDelaySec}s)`,
  );
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
    ctx.error(`Failed to log target retry comparison for ${name}`, error);
  }
};

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}
