import type { TargetCapabilitySnapshot } from '../../packages/contracts/src/types';
import { getPrimaryTargetCapability } from '../../packages/shared-domain/src/targetCapabilities';
import { getDebugEmitter, type StructuredDebugEmitter } from '../logging/logger';
import type { PendingTargetObservationSource, WantedTargetCommand } from '../ports/pendingTargetCommand';
import type { PendingTargetCommandState, ExecutionState } from './executionState';

import { TARGET_WAITING_LOG_REPEAT_MS } from '../ports/controlCommandConfirmation';
const emitPlanDebug = getDebugEmitter('plan', 'plan');
type PendingTargetStore = Pick<ExecutionState, 'pendingTargetCommands'>;
type ConfirmingTargetStore = Pick<ExecutionState, 'pendingTargetCommands' | 'controlContests'>;
export type PendingTargetObservedDevice = { id: string; name: string; targets: TargetCapabilitySnapshot[] };

/* eslint-disable functional/immutable-data, no-param-reassign --
   In-place update avoids another state or accumulator copy. */
export function prunePendingTargetCommands(
  state: PendingTargetStore,
  wantedTargets: ReadonlyMap<string, WantedTargetCommand>,
): boolean {
  let changed = false;
  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const wanted = wantedTargets.get(deviceId);
    if (wanted?.kind === 'target' && wanted.desired === pending.desired) continue;
    delete state.pendingTargetCommands[deviceId];
    changed = true;
    emitPlanDebug({
      event: 'pending_target_command_cleared',
      reason: 'plan_no_longer_wants',
      deviceId,
      deviceName: wanted?.name,
      desired: pending.desired,
    });
  }
  return changed;
}
/* eslint-enable functional/immutable-data, no-param-reassign */

export function syncPendingTargetCommands(
  state: ConfirmingTargetStore,
  liveDevices: PendingTargetObservedDevice[],
  source: PendingTargetObservationSource,
  structuredInfo: StructuredDebugEmitter,
): boolean {
  const liveById = new Map<string, PendingTargetObservedDevice>();
  for (const device of liveDevices) liveById.set(device.id, device);
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const liveDevice = liveById.get(deviceId);
    if (!liveDevice) {
      if (clearPendingTargetCommandForMissingDevice(state, deviceId, source)) {
        changed = true;
      }
      continue;
    }
    const observedValue = getObservedTargetValue(liveDevice);

    if (handleConfirmedPendingTargetObservation(
      state, liveDevice, pending, observedValue, source,
    )) {
      changed = true;
      continue;
    }

    if (handleTemporaryUnavailablePendingTargetObservation(
      liveDevice, pending, observedValue, source,
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
      liveDevice, pending, observedValue, source, structuredInfo,
    );
  }

  return changed;
}

function getObservedTargetValue(liveDevice: PendingTargetObservedDevice): unknown {
  return getPrimaryTargetCapability(liveDevice.targets)?.value;
}

/* eslint-disable functional/immutable-data, no-param-reassign -- Updates the pending command in place. */
function clearPendingTargetCommandForMissingDevice(
  state: PendingTargetStore,
  deviceId: string,
  source: PendingTargetObservationSource,
): boolean {
  const shouldClearMissingPending = source === 'snapshot_refresh' || source === 'rebuild';
  if (!shouldClearMissingPending) return false;
  delete state.pendingTargetCommands[deviceId];
  emitPlanDebug({
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
  state: ConfirmingTargetStore,
  liveDevice: PendingTargetObservedDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
): boolean {
  if (!Object.is(observedValue, pending.desired)) return false;
  delete state.pendingTargetCommands[liveDevice.id];
  state.controlContests.commandConfirmed(liveDevice.id, 'temperature', pending.desired);
  emitPlanDebug({
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
  liveDevice: PendingTargetObservedDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
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
  emitPlanDebug({
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
  liveDevice: PendingTargetObservedDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
  structuredInfo: StructuredDebugEmitter,
): void {
  const previousObservedValue = pending.lastObservedValue;
  const previousObservedSource = pending.lastObservedSource;
  pending.lastObservedValue = observedValue;
  pending.lastObservedSource = source;
  pending.lastObservedAtMs = Date.now();
  emitPlanDebug({
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
  if (observedValueChanged) {
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
  liveDevice: PendingTargetObservedDevice,
  pending: PendingTargetCommandState,
  observedValue: unknown,
  source: PendingTargetObservationSource,
  structuredInfo: StructuredDebugEmitter,
): void {
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
