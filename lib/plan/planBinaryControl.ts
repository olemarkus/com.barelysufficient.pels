import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import type { PendingTargetObservationSource, PlanInputDevice } from './planTypes';
import {
  getPendingBinaryCommandWindowMs,
  isPendingBinaryCommandActive,
  resolveBinaryCommandPendingMs,
} from './planObservationPolicy';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

export type BinaryControlPlan = {
  capabilityId: 'onoff' | 'evcharger_charging';
  isEv: boolean;
  canSet: boolean;
};

type BinaryControlLogContext = 'capacity' | 'capacity_control_off';
type BinaryControlRestoreSource = 'shed_state' | 'current_plan';
type BinaryControlActuationMode = 'plan' | 'reconcile';

type BinaryControlDeps = {
  state: PlanEngineState;
  deviceManager: DeviceManager;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
};

export function getBinaryControlPlan(snapshot?: TargetDeviceSnapshot): BinaryControlPlan | null {
  const capabilityId = resolveBinaryCapabilityId(snapshot);
  if (!snapshot || !capabilityId) return null;
  return {
    capabilityId,
    isEv: capabilityId === 'evcharger_charging',
    canSet: resolveCanSetBinaryControl(snapshot, capabilityId),
  };
}

export function getEvRestoreBlockReason(snapshot?: TargetDeviceSnapshot): string | null {
  if (!snapshot || snapshot.controlCapabilityId !== 'evcharger_charging') return null;
  if (snapshot.expectedPowerSource === 'default') {
    return 'charger power unknown';
  }
  if (snapshot.evChargingState === undefined) return 'charger state unknown';

  switch (snapshot.evChargingState) {
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case 'plugged_out':
      return 'charger is unplugged';
    case 'plugged_in_discharging':
      return 'charger is discharging';
    default:
      return `unknown charging state '${snapshot.evChargingState}'`;
  }
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

export async function setBinaryControl(params: BinaryControlDeps & {
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode?: BinaryControlActuationMode;
}): Promise<boolean> {
  const {
    state, deviceManager, log, logDebug, error, structuredLog, debugStructured,
    deviceId, name, desired, snapshot, logContext, restoreSource, reason,
    actuationMode = 'plan',
  } = params;
  const controlPlan = getBinaryControlPlan(snapshot);
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
    return false;
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
    return false;
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
    return false;
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
    return false;
  }

  if (controlPlan.isEv) {
    logDebug(
      `Capacity: EV action requested for ${name}: ${controlPlan.capabilityId}=${desired} `
      + `(${formatEvSnapshot(snapshot)}${reason ? `, reason=${reason}` : ''})`,
    );
  }

  return executeBinaryCommand({
    state, deviceManager, log, logDebug, error, structuredLog,
    controlPlan,
    pendingMs: resolveBinaryCommandPendingMs(snapshot?.communicationModel),
    deviceId,
    name,
    desired,
    logContext,
    reason,
    restoreSource,
    actuationMode,
  });
}

function resolveBinaryCapabilityId(
  snapshot?: TargetDeviceSnapshot,
): BinaryControlPlan['capabilityId'] | undefined {
  if (!snapshot) return undefined;
  if (snapshot.controlCapabilityId) return snapshot.controlCapabilityId;
  if (snapshot.capabilities?.includes('evcharger_charging')) return 'evcharger_charging';
  if (snapshot.capabilities?.includes('onoff')) return 'onoff';
  return undefined;
}

function resolveCanSetBinaryControl(
  snapshot: TargetDeviceSnapshot,
  capabilityId: BinaryControlPlan['capabilityId'],
): boolean {
  const legacyCanSetOnOff = (snapshot as (TargetDeviceSnapshot & { canSetOnOff?: boolean })).canSetOnOff;
  return snapshot.canSetControl !== false && !(capabilityId === 'onoff' && legacyCanSetOnOff === false);
}

function logMissingBinaryControlPlan(
  logDebug: (...args: unknown[]) => void,
  snapshot: TargetDeviceSnapshot | undefined,
  name: string,
): void {
  if (snapshot?.deviceClass !== 'evcharger') return;
  logDebug(`Capacity: cannot control EV ${name}, no binary control plan (${formatEvSnapshot(snapshot)})`);
}

function logNonSetableBinaryControl(
  logDebug: (...args: unknown[]) => void,
  controlPlan: BinaryControlPlan,
  snapshot: TargetDeviceSnapshot | undefined,
  name: string,
): void {
  if (!controlPlan.isEv) return;
  logDebug(`Capacity: cannot control EV ${name}, capability not setable (${formatEvSnapshot(snapshot)})`);
}

function shouldSkipAlreadyMatched(params: {
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

async function executeBinaryCommand(params: {
  state: PlanEngineState;
  deviceManager: DeviceManager;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
  controlPlan: BinaryControlPlan;
  pendingMs: number;
  deviceId: string;
  name: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
}): Promise<boolean> {
  const {
    state, deviceManager, log, logDebug, error, structuredLog,
    controlPlan, pendingMs, deviceId, name, desired, logContext, reason, restoreSource, actuationMode,
  } = params;

  state.pendingBinaryCommands[deviceId] = {
    capabilityId: controlPlan.capabilityId,
    desired,
    startedMs: Date.now(),
    pendingMs,
  };

  try {
    await deviceManager.setCapability(deviceId, controlPlan.capabilityId, desired);
    const logMessage = controlPlan.isEv
      ? buildEvBinaryControlLogMessage(logContext, desired, name, reason, actuationMode)
      : buildBinaryControlLogMessage({ logContext, desired, name, reason, restoreSource, actuationMode });
    log(logMessage);
    if (controlPlan.isEv) {
      logDebug(
        `Capacity: EV action completed for ${name}: ${controlPlan.capabilityId}=${desired} `
        + `(${formatEvSnapshot(deviceManager.getSnapshot().find((entry) => entry.id === deviceId))})`,
      );
    }
    return true;
  } catch (caughtError) {
    delete state.pendingBinaryCommands[deviceId];
    const verb = controlPlan.isEv
      ? `${desired ? 'resume' : 'pause'} EV charging for`
      : `${desired ? 'turn on' : 'turn off'}`;
    structuredLog?.error({
      event: 'binary_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId,
      deviceName: name,
      desired,
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
      ...(restoreSource ? { restoreSource } : {}),
      ...(reason ? { reason } : {}),
    });
    error(`Failed to ${verb} ${name} via DeviceManager`, caughtError);
    return false;
  }
}
function hasPendingMatchingBinaryCommand(params: {
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
  // This helper keeps prose logging for compatibility with existing debug output.
  return true;
}

function getPendingBinaryCommand(
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
  }).replace('cleared stale', 'clearing stale'));
  delete pendingBinaryCommands[deviceId];
  return undefined;
}

function buildBinaryControlLogMessage(params: {
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode?: BinaryControlActuationMode;
}): string {
  const {
    logContext,
    desired,
    name,
    reason,
    restoreSource = 'current_plan',
    actuationMode = 'plan',
  } = params;
  if (desired) {
    const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
    const suffix = resolveBinaryRestoreSuffix({ logContext, restoreSource, actuationMode });
    return `${prefix}: turning on ${name}${suffix}`;
  }
  if (actuationMode === 'reconcile') {
    return `Capacity: turned off ${name} (reconcile after drift)`;
  }
  if (reason && logContext === 'capacity') {
    return `Capacity: turned off ${name} (${reason})`;
  }
  if (logContext === 'capacity') {
    return `Capacity: turned off ${name} (shedding)`;
  }
  return `Capacity control off: turned off ${name}`;
}

function resolveBinaryRestoreSuffix(params: {
  logContext: BinaryControlLogContext;
  restoreSource: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
}): string {
  const { logContext, restoreSource, actuationMode } = params;
  if (logContext !== 'capacity') return '';
  if (actuationMode === 'reconcile') return ' (reconcile after drift)';
  return restoreSource === 'shed_state'
    ? ' (restored from shed state)'
    : ' (to match current plan)';
}

function buildEvBinaryControlLogMessage(
  logContext: BinaryControlLogContext,
  desired: boolean,
  name: string,
  reason?: string,
  actuationMode: BinaryControlActuationMode = 'plan',
): string {
  const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
  if (actuationMode === 'reconcile') {
    const actionText = desired ? 'resumed charging for' : 'paused charging for';
    return `${prefix}: ${actionText} ${name} (reconcile after drift)`;
  }
  const actionText = desired ? 'resumed charging for' : 'paused charging for';
  const suffix = !desired && reason ? ` (${reason})` : '';
  return `${prefix}: ${actionText} ${name}${suffix}`;
}

export function syncPendingBinaryCommands(params: {
  state: PlanEngineState;
  liveDevices: PlanInputDevice[];
  source: PendingTargetObservationSource;
  logDebug: (message: string) => void;
}): boolean {
  const {
    state,
    liveDevices,
    source,
    logDebug,
  } = params;
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  const nowMs = Date.now();
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingBinaryCommands)) {
    const liveDevice = liveById.get(deviceId);
    const ageMs = nowMs - pending.startedMs;
    if (!isPendingBinaryCommandActive({
      pending,
      nowMs,
      communicationModel: liveDevice?.communicationModel,
    })) {
      delete state.pendingBinaryCommands[deviceId];
      changed = true;
      logDebug(buildPendingBinaryTimeoutLogMessage({
        pending,
        name: liveDevice?.name || deviceId,
        ageMs,
      }));
      continue;
    }
    if (!liveDevice) continue;

    const observedValue = getObservedBinaryValue(liveDevice, pending.capabilityId);
    if (observedValue === pending.desired) {
      delete state.pendingBinaryCommands[deviceId];
      changed = true;
      logDebug(
        `Capacity: confirmed ${pending.capabilityId} for ${liveDevice.name || deviceId} `
        + `at ${formatPendingBinaryObservedValue(pending.capabilityId, observedValue)} via ${source}`,
      );
      continue;
    }

    if (
      pending.lastObservedValue === observedValue
      && pending.lastObservedSource === source
    ) {
      continue;
    }

    pending.lastObservedValue = observedValue;
    pending.lastObservedSource = source;
    pending.lastObservedAtMs = nowMs;
    changed = true;
    logDebug(
      `Capacity: waiting for ${pending.capabilityId} confirmation for ${liveDevice.name || deviceId}; `
      + `observed ${formatPendingBinaryObservedValue(pending.capabilityId, observedValue)} via ${source}, `
      + `expected ${formatPendingBinaryObservedValue(pending.capabilityId, pending.desired)}`,
    );
  }

  return changed;
}

function getObservedBinaryValue(
  liveDevice: PlanInputDevice,
  capabilityId: 'onoff' | 'evcharger_charging',
): boolean | string | undefined {
  if (capabilityId === 'evcharger_charging') {
    return resolveEvChargingObservedState(liveDevice.evChargingState);
  }
  return liveDevice.currentOn;
}

function resolveEvChargingObservedState(
  evChargingState: PlanInputDevice['evChargingState'],
): boolean | string | undefined {
  switch (evChargingState) {
    case 'plugged_in_charging':
      return true;
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_out':
    case 'plugged_in_discharging':
      return false;
    default:
      return evChargingState;
  }
}

function formatPendingBinaryObservedValue(
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

function buildPendingBinaryTimeoutLogMessage(params: {
  pending: PlanEngineState['pendingBinaryCommands'][string];
  name: string;
  ageMs: number;
}): string {
  const { pending, name, ageMs } = params;
  const timeoutMs = getPendingBinaryCommandWindowMs(pending);
  const observedSuffix = pending.lastObservedSource
    ? `; last observed ${formatPendingBinaryObservedValue(pending.capabilityId, pending.lastObservedValue)} `
      + `via ${pending.lastObservedSource}`
    : '';
  return `Capacity: cleared stale pending binary command for ${name}: `
    + `${pending.capabilityId}=${pending.desired} after ${ageMs}ms `
    + `(timeout ${timeoutMs}ms)${observedSuffix}`;
}
