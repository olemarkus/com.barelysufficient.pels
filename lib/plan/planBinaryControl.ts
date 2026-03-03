import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';
import { BINARY_COMMAND_PENDING_MS } from './planConstants';
import type { PlanEngineState } from './planState';

export type BinaryControlPlan = {
  capabilityId: 'onoff' | 'evcharger_charging';
  isEv: boolean;
  canSet: boolean;
};

type BinaryControlLogContext = 'capacity' | 'capacity_control_off';

type BinaryControlDeps = {
  state: PlanEngineState;
  deviceManager: DeviceManager;
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
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
  reason?: string;
}): Promise<boolean> {
  const {
    deviceId,
    name,
    desired,
    snapshot,
    logContext,
    reason,
  } = params;
  const controlPlan = getBinaryControlPlan(snapshot);
  if (!controlPlan) {
    logMissingBinaryControlPlan(params.logDebug, snapshot, name);
    return false;
  }
  if (!controlPlan.canSet) {
    logNonSetableBinaryControl(params.logDebug, controlPlan, snapshot, name);
    return false;
  }
  if (controlPlan.isEv) {
    return setEvBinaryControl({
      ...params,
      controlPlan,
      deviceId,
      name,
      desired,
      snapshot,
      logContext,
      reason,
    });
  }
  return setStandardBinaryControl({
    ...params,
    controlPlan,
    deviceId,
    name,
    desired,
    reason,
    logContext,
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

async function setEvBinaryControl(params: BinaryControlDeps & {
  controlPlan: BinaryControlPlan;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: BinaryControlLogContext;
  reason?: string;
}): Promise<boolean> {
  const {
    state,
    deviceManager,
    updateLocalSnapshot,
    log,
    logDebug,
    error,
    controlPlan,
    deviceId,
    name,
    desired,
    snapshot,
    logContext,
    reason,
  } = params;
  logDebug(
    `Capacity: EV action requested for ${name}: ${controlPlan.capabilityId}=${desired} `
    + `(${formatEvSnapshot(snapshot)}${reason ? `, reason=${reason}` : ''})`,
  );
  if (hasPendingMatchingBinaryCommand({
    state,
    deviceId,
    controlPlan,
    desired,
    logDebug,
    name,
  })) {
    return false;
  }

  state.pendingBinaryCommands[deviceId] = {
    capabilityId: controlPlan.capabilityId,
    desired,
    startedMs: Date.now(),
  };

  try {
    await deviceManager.setCapability(deviceId, controlPlan.capabilityId, desired);
    updateLocalSnapshot(deviceId, { on: desired });
    log(buildEvBinaryControlLogMessage(logContext, desired, name, reason));
    logDebug(
      `Capacity: EV action completed for ${name}: ${controlPlan.capabilityId}=${desired} `
      + `(${formatEvSnapshot(deviceManager.getSnapshot().find((entry) => entry.id === deviceId))})`,
    );
    return true;
  } catch (caughtError) {
    error(`Failed to ${desired ? 'resume' : 'pause'} EV charging for ${name} via DeviceManager`, caughtError);
    return false;
  }
}

async function setStandardBinaryControl(params: BinaryControlDeps & {
  controlPlan: BinaryControlPlan;
  deviceId: string;
  name: string;
  desired: boolean;
  reason?: string;
  logContext: BinaryControlLogContext;
}): Promise<boolean> {
  const {
    deviceManager,
    updateLocalSnapshot,
    log,
    error,
    controlPlan,
    deviceId,
    name,
    desired,
    reason,
    logContext,
  } = params;
  try {
    await deviceManager.setCapability(deviceId, controlPlan.capabilityId, desired);
    updateLocalSnapshot(deviceId, { on: desired });
    log(buildBinaryControlLogMessage(logContext, desired, name, reason));
    return true;
  } catch (caughtError) {
    error(`Failed to ${desired ? 'turn on' : 'turn off'} ${name} via DeviceManager`, caughtError);
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
  logDebug(`Capacity: skip EV command for ${name}, ${pending.capabilityId}=${pending.desired} already pending`);
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
  if ((Date.now() - entry.startedMs) < BINARY_COMMAND_PENDING_MS) {
    return entry;
  }
  logDebug(
    `Capacity: clearing stale pending binary command for ${deviceId}: `
    + `${entry.capabilityId}=${entry.desired} after ${Date.now() - entry.startedMs}ms`,
  );
  delete pendingBinaryCommands[deviceId];
  return undefined;
}

function buildBinaryControlLogMessage(
  logContext: BinaryControlLogContext,
  desired: boolean,
  name: string,
  reason?: string,
): string {
  if (desired) {
    const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
    const suffix = logContext === 'capacity' ? ' (restored from shed/off state)' : '';
    return `${prefix}: turning on ${name}${suffix}`;
  }
  if (reason && logContext === 'capacity') {
    return `Capacity: turned off ${name} (${reason})`;
  }
  if (logContext === 'capacity') {
    return `Capacity: turned off ${name} (shedding)`;
  }
  return `Capacity control off: turned off ${name}`;
}

function buildEvBinaryControlLogMessage(
  logContext: BinaryControlLogContext,
  desired: boolean,
  name: string,
  reason?: string,
): string {
  const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
  const actionText = desired ? 'resumed charging for' : 'paused charging for';
  const suffix = !desired && reason ? ` (${reason})` : '';
  return `${prefix}: ${actionText} ${name}${suffix}`;
}
