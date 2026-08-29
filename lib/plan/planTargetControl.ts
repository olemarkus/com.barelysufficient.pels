import { TARGET_WAITING_LOG_REPEAT_MS } from './planConstants';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PendingTargetCommandState, PlanEngineState } from './planState';
import type {
  DevicePlan,
  PendingTargetCommandSummary,
  PendingTargetObservationSource,
  PlanInputDevice,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';

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
    const shouldKeep = device !== undefined
      && isTemperaturePlanDevice(device)
      && device.plannedTarget !== device.currentTarget
      && device.plannedTarget === pending.desired;
    if (shouldKeep) continue;
    delete state.pendingTargetCommands[deviceId];
    changed = true;
    debugStructured?.({
      event: 'pending_target_command_cleared',
      reason: 'plan_no_longer_wants',
      deviceId,
      deviceName: device?.name,
      target: pending.target,
      desired: pending.desired,
    });
  }
  return changed;
}

export function syncPendingTargetCommands(params: {
  state: PlanEngineState;
  liveDevices: PlanInputDevice[];
  source: PendingTargetObservationSource;
  structuredInfo?: StructuredDebugEmitter;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    state,
    liveDevices,
    source,
    structuredInfo,
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
    const observedValue = getObservedTargetValue(liveDevice);

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
      maybeEmitRepeatedPendingConfirmation({
        pending,
        deviceId,
        name: liveDevice.name,
        structuredInfo,
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
      structuredInfo,
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
      && isTemperaturePlanDevice(device)
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

function getObservedTargetValue(liveDevice: PlanInputDevice): unknown {
  return getPrimaryTargetCapability(liveDevice.targets)?.value;
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
    target: pending.target,
    source,
  });
  return true;
}

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
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
    target: pending.target,
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
    target: pending.target,
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
  structuredInfo?: StructuredDebugEmitter;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const {
    deviceId,
    pending,
    observedValue,
    source,
    name,
    structuredInfo,
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
    target: pending.target,
    observed: formatObservedTarget(observedValue),
    source,
    expected: pending.desired,
  });
  const observedValueChanged = !(
    previousObservedSource !== undefined
    && Object.is(previousObservedValue, observedValue)
  );
  if (structuredInfo && observedValueChanged) {
    pending.lastWaitingLogAtMs = Date.now();
    structuredInfo({
      event: 'target_waiting_for_confirmation',
      deviceId,
      deviceName: name,
      target: pending.target,
      observed: formatObservedTarget(observedValue),
      previousObserved: previousObservedSource !== undefined
        ? formatObservedTarget(previousObservedValue)
        : undefined,
      source,
      expected: pending.desired,
    });
  }
}

function maybeEmitRepeatedPendingConfirmation(params: {
  pending: PendingTargetCommandState;
  deviceId: string;
  name: string;
  structuredInfo?: StructuredDebugEmitter;
  source: PendingTargetObservationSource;
  observedValue: unknown;
}): void {
  const {
    pending,
    deviceId,
    name,
    structuredInfo,
    source,
    observedValue,
  } = params;
  if (!structuredInfo) return;
  const nowMs = Date.now();
  if (
    typeof pending.lastWaitingLogAtMs === 'number'
    && (nowMs - pending.lastWaitingLogAtMs) < TARGET_WAITING_LOG_REPEAT_MS
  ) {
    return;
  }
  pending.lastWaitingLogAtMs = nowMs;
  structuredInfo({
    event: 'target_waiting_for_confirmation',
    deviceId,
    deviceName: name,
    target: pending.target,
    observed: formatObservedTarget(observedValue),
    source,
    expected: pending.desired,
  });
}
