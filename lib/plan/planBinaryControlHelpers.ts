import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import {
  getPendingBinaryCommandWindowMs,
  isPendingBinaryCommandActive,
} from './planObservationPolicy';
import type { StructuredDebugEmitter } from '../logging/logger';

export type BinaryControlPlan = {
  capabilityId: 'onoff' | 'evcharger_charging';
  isEv: boolean;
  canSet: boolean;
};

export type BinaryControlLogContext = 'capacity' | 'capacity_control_off';
export type BinaryControlRestoreSource = 'shed_state' | 'current_plan';
export type BinaryControlActuationMode = 'plan' | 'reconcile';

export function shouldSkipBinaryControl(params: {
  controlPlan: BinaryControlPlan | null;
  deviceManager: DeviceManager;
  deviceId: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  actuationMode: BinaryControlActuationMode;
  debugStructured?: StructuredDebugEmitter;
  logDebug: (...args: unknown[]) => void;
  name: string;
  snapshot?: TargetDeviceSnapshot;
  state: PlanEngineState;
}): boolean {
  const {
    controlPlan,
    deviceManager,
    deviceId,
    desired,
    logContext,
    actuationMode,
    debugStructured,
    logDebug,
    name,
    snapshot,
    state,
  } = params;
  if (!controlPlan) {
    const hasTargets = Array.isArray(snapshot?.targets) && snapshot.targets.length > 0;
    debugStructured?.({
      event: 'binary_command_skipped',
      reasonCode: hasTargets ? 'missing_onoff_capability' : 'missing_control_targets',
      deviceId,
      deviceName: name,
      desired,
      logContext,
      actuationMode,
      hasTargets,
      capabilityId: snapshot?.controlCapabilityId ?? null,
    });
    logMissingBinaryControlPlan(logDebug, snapshot, name);
    return true;
  }
  if (!controlPlan.canSet) {
    debugStructured?.({
      event: 'binary_command_skipped',
      reasonCode: 'capability_not_setable',
      deviceId,
      deviceName: name,
      desired,
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
    });
    logNonSetableBinaryControl(logDebug, controlPlan, snapshot, name);
    return true;
  }
  if (shouldSkipAlreadyMatched({ deviceManager, controlPlan, deviceId, name, desired, snapshot, logDebug })) {
    debugStructured?.({
      event: 'binary_command_skipped',
      reasonCode: 'already_matched',
      deviceId,
      deviceName: name,
      desired,
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
    });
    return true;
  }
  if (hasPendingMatchingBinaryCommand({ state, deviceId, controlPlan, desired, logDebug, name })) {
    debugStructured?.({
      event: 'binary_command_skipped',
      reasonCode: 'already_pending',
      deviceId,
      deviceName: name,
      desired,
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
    });
    return true;
  }
  return false;
}

export function logMissingBinaryControlPlan(
  logDebug: (...args: unknown[]) => void,
  snapshot: TargetDeviceSnapshot | undefined,
  name: string,
): void {
  if (snapshot?.deviceClass !== 'evcharger') return;
  logDebug(`Capacity: cannot control EV ${name}, no binary control plan (${formatEvSnapshot(snapshot)})`);
}

export function logNonSetableBinaryControl(
  logDebug: (...args: unknown[]) => void,
  controlPlan: BinaryControlPlan,
  snapshot: TargetDeviceSnapshot | undefined,
  name: string,
): void {
  if (!controlPlan.isEv) return;
  logDebug(`Capacity: cannot control EV ${name}, capability not setable (${formatEvSnapshot(snapshot)})`);
}

export function shouldSkipAlreadyMatched(params: {
  deviceManager: DeviceManager;
  controlPlan: BinaryControlPlan;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logDebug: (...args: unknown[]) => void;
}): boolean {
  const { deviceManager, controlPlan, deviceId, name, desired, snapshot, logDebug } = params;
  if (controlPlan.isEv) return false;
  const latestObservedSnapshot = deviceManager.getSnapshot().find((entry) => entry.id === deviceId) ?? snapshot;
  if (typeof latestObservedSnapshot?.currentOn !== 'boolean') return false;
  if (latestObservedSnapshot.currentOn !== desired) return false;
  logDebug(`Capacity: skip binary command for ${name}, already ${desired ? 'on' : 'off'} in current snapshot`);
  return true;
}

export function hasPendingMatchingBinaryCommand(params: {
  state: PlanEngineState;
  deviceId: string;
  controlPlan: BinaryControlPlan;
  desired: boolean;
  logDebug: (...args: unknown[]) => void;
  name: string;
}): boolean {
  const {
    state,
    deviceId,
    controlPlan,
    desired,
    logDebug,
    name,
  } = params;
  const pending = getPendingBinaryCommand(state, deviceId, logDebug);
  if (!pending) return false;
  const isMatchingCommand = pending.capabilityId === controlPlan.capabilityId && pending.desired === desired;
  if (!isMatchingCommand) return false;
  const commandType = controlPlan.isEv ? 'EV command' : 'binary command';
  logDebug(`Capacity: skip ${commandType} for ${name}, ${pending.capabilityId}=${pending.desired} already pending`);
  return true;
}

export function getPendingBinaryCommand(
  state: PlanEngineState,
  deviceId: string,
  logDebug: (...args: unknown[]) => void,
): PlanEngineState['pendingBinaryCommands'][string] | undefined {
  const pendingBinaryCommands = state.pendingBinaryCommands;
  const entry = pendingBinaryCommands[deviceId];
  if (!entry) return undefined;
  if (isPendingBinaryCommandActive({ pending: entry })) {
    return entry;
  }
  const ageMs = Date.now() - entry.startedMs;
  logDebug(buildPendingBinaryTimeoutLogMessage({
    pending: entry,
    name: deviceId,
    ageMs,
    tense: 'clearing',
  }));
  delete pendingBinaryCommands[deviceId];
  return undefined;
}

export function buildPendingBinaryTimeoutLogMessage(params: {
  pending: PlanEngineState['pendingBinaryCommands'][string];
  name: string;
  ageMs: number;
  tense?: 'clearing' | 'cleared';
}): string {
  const { pending, name, ageMs, tense = 'cleared' } = params;
  const timeoutMs = getPendingBinaryCommandWindowMs(pending);
  const observedSuffix = pending.lastObservedSource
    ? `; last observed ${formatPendingBinaryObservedValue(pending.capabilityId, pending.lastObservedValue)} `
      + `via ${pending.lastObservedSource}`
    : '';
  return `Capacity: ${tense} stale pending binary command for ${name}: `
    + `${pending.capabilityId}=${pending.desired} after ${ageMs}ms `
    + `(timeout ${timeoutMs}ms)${observedSuffix}`;
}

export function formatEvSnapshot(snapshot?: TargetDeviceSnapshot): string {
  if (!snapshot) return 'snapshot=missing';
  return [
    `currentOn=${String(snapshot.currentOn)}`,
    `evState=${snapshot.evChargingState ?? 'unknown'}`,
    `available=${snapshot.available !== false}`,
    `canSet=${snapshot.canSetControl !== false}`,
    `powerKw=${snapshot.powerKw ?? snapshot.measuredPowerKw ?? snapshot.expectedPowerKw ?? 'unknown'}`,
    `expectedPowerKw=${snapshot.expectedPowerKw ?? 'unknown'}`,
  ].join(', ');
}

export function formatPendingBinaryObservedValue(
  capabilityId: 'onoff' | 'evcharger_charging',
  value: boolean | string | undefined,
): string {
  if (capabilityId === 'evcharger_charging') {
    if (value === true) return 'charging';
    if (value === false) return 'paused';
    return String(value ?? 'unknown');
  }
  if (value === true) return 'on';
  if (value === false) return 'off';
  return String(value ?? 'unknown');
}
