import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import type { PendingTargetObservationSource, PlanInputDevice } from './planTypes';
import {
  resolveBinaryCommandPendingMs,
  isPendingBinaryCommandActive,
} from './planObservationPolicy';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  buildPendingBinaryTimeoutLogMessage,
  type BinaryControlActuationMode,
  type BinaryControlLogContext,
  type BinaryControlPlan,
  type BinaryControlRestoreSource,
  shouldSkipBinaryControl,
  formatPendingBinaryObservedValue,
} from './planBinaryControlHelpers';

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
  if (shouldSkipBinaryControl({
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
  })) {
    return false;
  }
  if (!controlPlan) return false;

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
        name: liveDevice ? liveDevice.name : `device ${deviceId}`,
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
        `Capacity: confirmed ${pending.capabilityId} for ${liveDevice.name} `
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
      `Capacity: waiting for ${pending.capabilityId} confirmation for ${liveDevice.name}; `
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
