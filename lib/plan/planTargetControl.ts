import { TARGET_WAITING_LOG_REPEAT_MS } from './planConstants';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { PendingTargetCommandState, PlanEngineState } from './planState';
import type {
  DevicePlan,
  DevicePlanDevice,
  PendingTargetCommandSummary,
  PendingTargetObservationSource,
  PlanInputDevice,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { getPrimaryTargetCapability } from '../../packages/shared-domain/src/targetCapabilities';

/**
 * Whether the plan still wants the target a pending command is writing: a
 * temperature device whose planned target moves it and is the value the
 * command is waiting to see. One answer for the three readers that keep,
 * expose, or attribute the pending command.
 */
export function planStillWantsPendingTarget(
  device: DevicePlanDevice,
  pending: PendingTargetCommandState,
): boolean {
  return isTemperaturePlanDevice(device)
    && device.plannedTarget !== device.currentTarget
    && device.plannedTarget === pending.desired;
}

/* eslint-disable functional/immutable-data, no-param-reassign --
   In-place update avoids another state or accumulator copy. */
export function prunePendingTargetCommandsForPlan(
  state: PlanEngineState,
  plan: DevicePlan,
  debugStructured?: StructuredDebugEmitter,
): boolean {
  const planById = new Map<string, DevicePlan['devices'][number]>();
  for (const device of plan.devices) planById.set(device.id, device);
  let changed = false;
  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const device = planById.get(deviceId);
    if (device !== undefined && planStillWantsPendingTarget(device, pending)) continue;
    delete state.pendingTargetCommands[deviceId];
    changed = true;
    debugStructured?.({
      event: 'pending_target_command_cleared',
      reason: 'plan_no_longer_wants',
      deviceId,
      deviceName: device?.name,
      desired: pending.desired,
    });
  }
  return changed;
}
/* eslint-enable functional/immutable-data, no-param-reassign */

export function syncPendingTargetCommands(
  state: PlanEngineState,
  liveDevices: PlanInputDevice[],
  source: PendingTargetObservationSource,
  structuredInfo: StructuredDebugEmitter,
  debugStructured: StructuredDebugEmitter | undefined,
): boolean {
  const liveById = new Map<string, PlanInputDevice>();
  for (const device of liveDevices) liveById.set(device.id, device);
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const liveDevice = liveById.get(deviceId);
    if (!liveDevice) {
      if (clearPendingTargetCommandForMissingDevice(state, deviceId, source, debugStructured)) {
        changed = true;
      }
      continue;
    }
    const observedValue = getObservedTargetValue(liveDevice);

    if (handleConfirmedPendingTargetObservation(
      state, liveDevice, pending, observedValue, source, debugStructured,
    )) {
      changed = true;
      continue;
    }

    if (handleTemporaryUnavailablePendingTargetObservation(
      liveDevice, pending, observedValue, source, debugStructured,
    )) {
      changed = true;
      continue;
    }

    if (
      Object.is(pending.lastObservedValue, observedValue)
      && pending.lastObservedSource === source
    ) {
      maybeEmitRepeatedPendingConfirmation(liveDevice, pending, observedValue, source, structuredInfo);
      continue;
    }

    changed = true;
    updatePendingTargetWaitingObservation(
      liveDevice, pending, observedValue, source, structuredInfo, debugStructured,
    );
  }

  return changed;
}

export function decoratePlanWithPendingTargetCommands(
  state: PlanEngineState,
  plan: DevicePlan,
): DevicePlan {
  const devices = plan.devices.map((device) => {
    const pending = state.pendingTargetCommands[device.id];
    if (!pending || !planStillWantsPendingTarget(device, pending)) {
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

/* eslint-disable functional/immutable-data, no-param-reassign -- Updates the pending command in place. */
function clearPendingTargetCommandForMissingDevice(
  state: PlanEngineState,
  deviceId: string,
  source: PendingTargetObservationSource,
  debugStructured: StructuredDebugEmitter | undefined,
): boolean {
  const shouldClearMissingPending = source === 'snapshot_refresh' || source === 'rebuild';
  if (!shouldClearMissingPending) return false;
  delete state.pendingTargetCommands[deviceId];
  debugStructured?.({
    event: 'pending_target_command_cleared',
    reason: 'device_missing',
    deviceId,
    source,
  });
  return true;
}
/* eslint-enable functional/immutable-data, no-param-reassign */

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}

/* eslint-disable functional/immutable-data, no-param-reassign -- Updates the pending command in place. */
function handleConfirmedPendingTargetObservation(
  state: PlanEngineState,
  liveDevice: PlanInputDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
  debugStructured: StructuredDebugEmitter | undefined,
): boolean {
  if (!Object.is(observedValue, pending.desired)) return false;
  delete state.pendingTargetCommands[liveDevice.id];
  debugStructured?.({
    event: 'pending_target_command_confirmed',
    deviceId: liveDevice.id,
    deviceName: liveDevice.name,
    desired: pending.desired,
    source,
  });
  return true;
}
/* eslint-enable functional/immutable-data, no-param-reassign */

/* eslint-disable functional/immutable-data, no-param-reassign -- Updates the pending command in place. */
function handleTemporaryUnavailablePendingTargetObservation(
  liveDevice: PlanInputDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
  debugStructured: StructuredDebugEmitter | undefined,
): boolean {
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
    deviceId: liveDevice.id,
    deviceName: liveDevice.name,
    observed: formatObservedTarget(observedValue),
    source,
    retryInSec: remainingSec,
  });
  return true;
}
/* eslint-enable functional/immutable-data, no-param-reassign */

/* eslint-disable functional/immutable-data, no-param-reassign -- Updates the pending command in place. */
function updatePendingTargetWaitingObservation(
  liveDevice: PlanInputDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
  structuredInfo: StructuredDebugEmitter | undefined,
  debugStructured: StructuredDebugEmitter | undefined,
): void {
  const previousObservedValue = pending.lastObservedValue;
  const previousObservedSource = pending.lastObservedSource;
  pending.lastObservedValue = observedValue;
  pending.lastObservedSource = source;
  pending.lastObservedAtMs = Date.now();
  debugStructured?.({
    event: 'pending_target_command_waiting',
    deviceId: liveDevice.id,
    deviceName: liveDevice.name,
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
      deviceId: liveDevice.id,
      deviceName: liveDevice.name,
      observed: formatObservedTarget(observedValue),
      previousObserved: previousObservedSource !== undefined
        ? formatObservedTarget(previousObservedValue)
        : undefined,
      source,
      expected: pending.desired,
    });
  }
}
/* eslint-enable functional/immutable-data, no-param-reassign */

/* eslint-disable functional/immutable-data, no-param-reassign -- Updates the pending command in place. */
function maybeEmitRepeatedPendingConfirmation(
  liveDevice: PlanInputDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
  structuredInfo: StructuredDebugEmitter | undefined,
): void {
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
    deviceId: liveDevice.id,
    deviceName: liveDevice.name,
    observed: formatObservedTarget(observedValue),
    source,
    expected: pending.desired,
  });
}
/* eslint-enable functional/immutable-data, no-param-reassign */
