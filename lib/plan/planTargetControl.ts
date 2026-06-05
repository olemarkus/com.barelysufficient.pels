import {
  TARGET_COMMAND_RETRY_DELAYS_MS,
  TARGET_WAITING_LOG_REPEAT_MS,
} from './planConstants';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PendingTargetCommandState, PlanEngineState } from './planState';
import type {
  DevicePlan,
  PendingTargetCommandSummary,
  PendingTargetObservationSource,
  PlanInputDevice,
} from './planTypes';

type PendingTargetDecision =
  | { type: 'send' }
  | { type: 'retry'; pending: PendingTargetCommandState }
  | { type: 'skip'; pending: PendingTargetCommandState; remainingMs: number };

export function getPendingTargetCommandDecision(params: {
  state: PlanEngineState;
  deviceId: string;
  capabilityId: string;
  desired: number;
  nowMs: number;
}): PendingTargetDecision {
  const { state, deviceId, capabilityId, desired, nowMs } = params;
  const pending = state.pendingTargetCommands[deviceId];
  if (!pending || pending.capabilityId !== capabilityId || pending.desired !== desired) {
    return { type: 'send' };
  }
  if (nowMs >= pending.nextRetryAtMs) {
    return { type: 'retry', pending };
  }
  return {
    type: 'skip',
    pending,
    remainingMs: pending.nextRetryAtMs - nowMs,
  };
}

export function recordPendingTargetCommandAttempt(params: {
  state: PlanEngineState;
  deviceId: string;
  capabilityId: string;
  desired: number;
  nowMs: number;
  observedValue?: unknown;
}): PendingTargetCommandState {
  const {
    state,
    deviceId,
    capabilityId,
    desired,
    nowMs,
    observedValue,
  } = params;
  const previous = state.pendingTargetCommands[deviceId];
  const isRetry = previous?.capabilityId === capabilityId && previous.desired === desired;
  const retryCount = isRetry ? previous.retryCount + 1 : 0;
  const entry: PendingTargetCommandState = {
    capabilityId,
    desired,
    startedMs: isRetry ? previous.startedMs : nowMs,
    lastAttemptMs: nowMs,
    retryCount,
    nextRetryAtMs: nowMs + getTargetCommandRetryDelayMs(retryCount),
    status: 'waiting_confirmation',
    lastObservedValue: resolvePendingTargetObservedValue({
      isRetry,
      observedValue,
      previous,
    }),
    lastObservedSource: isRetry ? previous?.lastObservedSource : undefined,
    lastObservedAtMs: isRetry ? previous?.lastObservedAtMs : undefined,
    lastWaitingLogAtMs: isRetry ? previous?.lastWaitingLogAtMs : undefined,
  };
  state.pendingTargetCommands[deviceId] = entry;
  return entry;
}

export function recordFailedPendingTargetCommandAttempt(params: {
  state: PlanEngineState;
  deviceId: string;
  capabilityId: string;
  desired: number;
  nowMs: number;
  observedValue?: unknown;
}): PendingTargetCommandState {
  const {
    state,
    deviceId,
    capabilityId,
    desired,
    nowMs,
    observedValue,
  } = params;
  const previous = state.pendingTargetCommands[deviceId];
  const isRetry = previous?.capabilityId === capabilityId && previous.desired === desired;
  const retryCount = isRetry ? previous.retryCount + 1 : 0;
  const entry: PendingTargetCommandState = {
    capabilityId,
    desired,
    startedMs: isRetry ? previous.startedMs : nowMs,
    lastAttemptMs: nowMs,
    retryCount,
    nextRetryAtMs: nowMs + getTargetCommandRetryDelayMs(retryCount),
    status: 'temporary_unavailable',
    lastObservedValue: resolvePendingTargetObservedValue({
      isRetry,
      observedValue,
      previous,
    }),
    lastObservedSource: isRetry ? previous?.lastObservedSource : undefined,
    lastObservedAtMs: isRetry ? previous?.lastObservedAtMs : undefined,
    lastWaitingLogAtMs: undefined,
  };
  state.pendingTargetCommands[deviceId] = entry;
  return entry;
}

export function prunePendingTargetCommandsForPlan(params: {
  state: PlanEngineState;
  plan: DevicePlan;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const { state, plan, debugStructured } = params;
  const planById = new Map(plan.devices.map((device) => [device.id, device]));
  let changed = false;
  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const device = planById.get(deviceId);
    const shouldKeep = Boolean(
      device
      && typeof device.plannedTarget === 'number'
      && device.plannedTarget !== device.currentTarget
      && device.plannedTarget === pending.desired,
    );
    if (shouldKeep) continue;
    delete state.pendingTargetCommands[deviceId];
    changed = true;
    debugStructured?.({
      event: 'pending_target_command_cleared',
      reason: 'plan_no_longer_wants',
      deviceId,
      deviceName: device?.name,
      capabilityId: pending.capabilityId,
      desired: pending.desired,
    });
  }
  return changed;
}

export function syncPendingTargetCommands(params: {
  state: PlanEngineState;
  liveDevices: PlanInputDevice[];
  source: PendingTargetObservationSource;
  log?: (message: string) => void;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    state,
    liveDevices,
    source,
    log,
    debugStructured,
  } = params;
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const liveDevice = liveById.get(deviceId);
    if (!liveDevice) {
      if (clearPendingTargetCommandForMissingDevice({
        state,
        deviceId,
        pending,
        source,
        debugStructured,
      })) {
        changed = true;
      }
      continue;
    }
    const observedValue = getObservedTargetValue(liveDevice, pending.capabilityId);

    if (handleConfirmedPendingTargetObservation({
      state,
      deviceId,
      pending,
      observedValue,
      source,
      name: liveDevice.name,
      debugStructured,
    })) {
      changed = true;
      continue;
    }

    if (handleTemporaryUnavailablePendingTargetObservation({
      deviceId,
      pending,
      observedValue,
      source,
      name: liveDevice.name,
      debugStructured,
    })) {
      changed = true;
      continue;
    }

    if (
      Object.is(pending.lastObservedValue, observedValue)
      && pending.lastObservedSource === source
    ) {
      maybeLogRepeatedPendingConfirmation({
        pending,
        name: liveDevice.name,
        log,
        source,
        observedValue,
      });
      continue;
    }

    changed = true;
    updatePendingTargetWaitingObservation({
      deviceId,
      pending,
      observedValue,
      source,
      name: liveDevice.name,
      log,
      debugStructured,
    });
  }

  return changed;
}

export function decoratePlanWithPendingTargetCommands(
  state: PlanEngineState,
  plan: DevicePlan,
): DevicePlan {
  const devices = plan.devices.map((device) => {
    const pending = state.pendingTargetCommands[device.id];
    const shouldExpose = pending
      && typeof device.plannedTarget === 'number'
      && device.plannedTarget !== device.currentTarget
      && device.plannedTarget === pending.desired;
    if (!shouldExpose) {
      if (!device.pendingTargetCommand) return device;
      return {
        ...device,
        pendingTargetCommand: undefined,
      };
    }
    const summary: PendingTargetCommandSummary = {
      desired: pending.desired,
      retryCount: pending.retryCount,
      nextRetryAtMs: pending.nextRetryAtMs,
      status: pending.status,
      lastObservedValue: pending.lastObservedValue,
      lastObservedSource: pending.lastObservedSource,
    };
    return {
      ...device,
      pendingTargetCommand: summary,
    };
  });

  return {
    ...plan,
    devices,
  };
}

function getTargetCommandRetryDelayMs(retryCount: number): number {
  const index = Math.min(retryCount, TARGET_COMMAND_RETRY_DELAYS_MS.length - 1);
  return TARGET_COMMAND_RETRY_DELAYS_MS[index];
}

function getObservedTargetValue(
  liveDevice: PlanInputDevice,
  capabilityId: string,
): unknown {
  return liveDevice.targets.find((target) => target.id === capabilityId)?.value;
}

function clearPendingTargetCommandForMissingDevice(params: {
  state: PlanEngineState;
  deviceId: string;
  pending: PendingTargetCommandState;
  source: PendingTargetObservationSource;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const { state, deviceId, pending, source, debugStructured } = params;
  const shouldClearMissingPending = source === 'snapshot_refresh' || source === 'rebuild';
  if (!shouldClearMissingPending) return false;
  delete state.pendingTargetCommands[deviceId];
  debugStructured?.({
    event: 'pending_target_command_cleared',
    reason: 'device_missing',
    deviceId,
    capabilityId: pending.capabilityId,
    source,
  });
  return true;
}

function resolvePendingTargetObservedValue(params: {
  isRetry: boolean;
  observedValue: unknown;
  previous?: PendingTargetCommandState;
}): unknown {
  const { isRetry, observedValue, previous } = params;
  if (observedValue !== undefined) return observedValue;
  return isRetry ? previous?.lastObservedValue : undefined;
}

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}

export function isPendingTargetCommandTemporarilyUnavailable(
  pending: PendingTargetCommandState | undefined,
): boolean {
  return pending?.status === 'temporary_unavailable';
}

function handleConfirmedPendingTargetObservation(params: {
  state: PlanEngineState;
  deviceId: string;
  pending: PendingTargetCommandState;
  observedValue: unknown;
  source: PendingTargetObservationSource;
  name: string;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    state,
    deviceId,
    pending,
    observedValue,
    source,
    name,
    debugStructured,
  } = params;
  if (!Object.is(observedValue, pending.desired)) return false;
  delete state.pendingTargetCommands[deviceId];
  debugStructured?.({
    event: 'pending_target_command_confirmed',
    deviceId,
    deviceName: name,
    capabilityId: pending.capabilityId,
    desired: pending.desired,
    source,
  });
  return true;
}

function handleTemporaryUnavailablePendingTargetObservation(params: {
  deviceId: string;
  pending: PendingTargetCommandState;
  observedValue: unknown;
  source: PendingTargetObservationSource;
  name: string;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    deviceId,
    pending,
    observedValue,
    source,
    name,
    debugStructured,
  } = params;
  if (pending.status !== 'temporary_unavailable') return false;
  if (
    Object.is(pending.lastObservedValue, observedValue)
    && pending.lastObservedSource === source
  ) {
    return false;
  }
  pending.lastObservedValue = observedValue;
  pending.lastObservedSource = source;
  pending.lastObservedAtMs = Date.now();
  const remainingSec = Math.max(1, Math.ceil((pending.nextRetryAtMs - Date.now()) / 1000));
  debugStructured?.({
    event: 'pending_target_command_unavailable',
    deviceId,
    deviceName: name,
    capabilityId: pending.capabilityId,
    observed: formatObservedTarget(observedValue),
    source,
    retryInSec: remainingSec,
  });
  return true;
}

function updatePendingTargetWaitingObservation(params: {
  deviceId: string;
  pending: PendingTargetCommandState;
  observedValue: unknown;
  source: PendingTargetObservationSource;
  name: string;
  log?: (message: string) => void;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const {
    deviceId,
    pending,
    observedValue,
    source,
    name,
    log,
    debugStructured,
  } = params;
  const previousObservedValue = pending.lastObservedValue;
  const previousObservedSource = pending.lastObservedSource;
  pending.lastObservedValue = observedValue;
  pending.lastObservedSource = source;
  pending.lastObservedAtMs = Date.now();
  debugStructured?.({
    event: 'pending_target_command_waiting',
    deviceId,
    deviceName: name,
    capabilityId: pending.capabilityId,
    observed: formatObservedTarget(observedValue),
    source,
    expected: pending.desired,
  });
  const waitingLog = buildPendingConfirmationLogMessage({
    name,
    capabilityId: pending.capabilityId,
    desired: pending.desired,
    source,
    previousObservedValue,
    previousObservedSource,
    observedValue,
  });
  if (log && waitingLog) {
    pending.lastWaitingLogAtMs = Date.now();
    log(waitingLog);
  }
}

function buildPendingConfirmationLogMessage(params: {
  name: string;
  capabilityId: string;
  desired: number;
  source: PendingTargetObservationSource;
  previousObservedValue?: unknown;
  previousObservedSource?: PendingTargetObservationSource;
  observedValue: unknown;
}): string | null {
  const {
    name,
    capabilityId,
    desired,
    source,
    previousObservedValue,
    previousObservedSource,
    observedValue,
  } = params;
  if (
    previousObservedSource !== undefined
    && Object.is(previousObservedValue, observedValue)
  ) {
    return null;
  }
  if (previousObservedSource !== undefined) {
    return `Target still waiting for ${capabilityId} confirmation for ${name}: `
      + `${formatObservedTarget(previousObservedValue)} -> ${formatObservedTarget(observedValue)} `
      + `via ${source}; expected ${desired}°C`;
  }
  return `Target still waiting for ${capabilityId} confirmation for ${name}: `
    + `observed ${formatObservedTarget(observedValue)} via ${source}; `
    + `expected ${desired}°C`;
}

function maybeLogRepeatedPendingConfirmation(params: {
  pending: PendingTargetCommandState;
  name: string;
  log?: (message: string) => void;
  source: PendingTargetObservationSource;
  observedValue: unknown;
}): void {
  const {
    pending,
    name,
    log,
    source,
    observedValue,
  } = params;
  if (!log) return;
  const nowMs = Date.now();
  if (
    typeof pending.lastWaitingLogAtMs === 'number'
    && (nowMs - pending.lastWaitingLogAtMs) < TARGET_WAITING_LOG_REPEAT_MS
  ) {
    return;
  }
  pending.lastWaitingLogAtMs = nowMs;
  log(
    `Target still waiting for ${pending.capabilityId} confirmation for ${name}: `
    + `observed ${formatObservedTarget(observedValue)} via ${source}; `
    + `expected ${pending.desired}°C`,
  );
}
