import type { DeviceManager } from '../core/deviceManager';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import type { BinarySettleEvidenceByDeviceId, PendingTargetObservationSource, PlanInputDevice } from './planTypes';
import {
  resolveBinaryCommandPendingMs,
  isPendingBinaryCommandActive,
} from './planObservationPolicy';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  buildFlowBackedBinaryControlRequestLogMessage,
  buildFlowBackedEvBinaryControlRequestLogMessage,
  resolveBinaryRestoreSuffix,
  type BinaryControlActuationMode,
  type BinaryControlLogContext,
  type BinaryControlPlan,
  type BinaryControlRestoreSource,
  applyBinarySettleEvidence,
  formatEvSnapshot,
  clearTimedOutPendingBinaryCommand,
  getMatchingBinarySettleEvidence,
  isFlowBackedBinaryControl,
  shouldSkipBinaryControl,
} from './planBinaryControlHelpers';

export { formatEvSnapshot, isFlowBackedBinaryControl } from './planBinaryControlHelpers';

type BinaryControlDeps = {
  state: PlanEngineState;
  deviceManager: DeviceManager;
  triggerFlowBackedBinaryControlRequest?: (params: {
    deviceId: string;
    name: string;
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    logContext: BinaryControlLogContext;
    actuationMode: BinaryControlActuationMode;
  }) => Promise<void>;
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
  if (snapshot.evChargingState === undefined) return 'charger state unknown';

  switch (snapshot.evChargingState) {
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case 'plugged_in':
      return 'charger is not resumable';
    case 'plugged_out':
      return 'charger is unplugged';
    case 'plugged_in_discharging':
      return 'charger is discharging';
    default:
      return `unknown charging state '${snapshot.evChargingState}'`;
  }
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
    state, deviceManager, triggerFlowBackedBinaryControlRequest, log, logDebug, error, structuredLog, debugStructured,
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
    state, deviceManager, triggerFlowBackedBinaryControlRequest, log, logDebug, error, structuredLog,
    controlPlan,
    pendingMs: resolveBinaryCommandPendingMs(snapshot?.communicationModel),
    deviceId,
    name,
    desired,
    snapshot,
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
  triggerFlowBackedBinaryControlRequest?: BinaryControlDeps['triggerFlowBackedBinaryControlRequest'];
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
  controlPlan: BinaryControlPlan;
  pendingMs: number;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: BinaryControlLogContext;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
}): Promise<boolean> {
  const {
    state, deviceManager, triggerFlowBackedBinaryControlRequest, log, logDebug, error, structuredLog,
    controlPlan, pendingMs, deviceId, name, desired, snapshot, logContext, reason, restoreSource, actuationMode,
  } = params;
  const flowBackedControl = isFlowBackedBinaryControl(snapshot, controlPlan.capabilityId);

  state.pendingBinaryCommands[deviceId] = {
    capabilityId: controlPlan.capabilityId,
    desired,
    startedMs: Date.now(),
    pendingMs,
    flowBackedControl,
    logContext,
    restoreSource,
    actuationMode,
    ...(reason ? { reason } : {}),
  };

  try {
    if (flowBackedControl) {
      await requestFlowBackedBinaryControl({
        triggerFlowBackedBinaryControlRequest,
        structuredLog,
        deviceId,
        name,
        capabilityId: controlPlan.capabilityId,
        desired,
        logContext,
        actuationMode,
      });
    } else {
      await deviceManager.setCapability(deviceId, controlPlan.capabilityId, desired);
    }
    log(buildBinaryControlSuccessLogMessage({
      controlPlan,
      logContext,
      desired,
      name,
      reason,
      restoreSource,
      actuationMode,
      flowBackedControl,
    }));
    if (controlPlan.isEv) {
      logDebug(
        `Capacity: EV action ${flowBackedControl ? 'requested' : 'completed'} for ${name}: `
        + `${controlPlan.capabilityId}=${desired} `
        + `(${formatEvSnapshot(deviceManager.getSnapshot().find((entry) => entry.id === deviceId))})`,
      );
    }
    return true;
  } catch (caughtError) {
    delete state.pendingBinaryCommands[deviceId];
    structuredLog?.error({
      event: flowBackedControl ? 'flow_backed_binary_command_failed' : 'binary_command_failed',
      reasonCode: flowBackedControl ? 'flow_trigger_failed' : 'device_manager_write_failed',
      deviceId,
      deviceName: name,
      desired,
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
      ...(restoreSource ? { restoreSource } : {}),
      ...(reason ? { reason } : {}),
    });
    error(buildBinaryControlFailureLogMessage({
      controlPlan,
      desired,
      name,
      flowBackedControl,
    }), caughtError);
    return false;
  }
}

async function requestFlowBackedBinaryControl(params: {
  triggerFlowBackedBinaryControlRequest?: BinaryControlDeps['triggerFlowBackedBinaryControlRequest'];
  structuredLog?: PinoLogger;
  deviceId: string;
  name: string;
  capabilityId: 'onoff' | 'evcharger_charging';
  desired: boolean;
  logContext: BinaryControlLogContext;
  actuationMode: BinaryControlActuationMode;
}): Promise<void> {
  const {
    triggerFlowBackedBinaryControlRequest,
    structuredLog,
    deviceId,
    name,
    capabilityId,
    desired,
    logContext,
    actuationMode,
  } = params;
  if (!triggerFlowBackedBinaryControlRequest) {
    throw new Error(`Flow-backed control trigger is unavailable for ${capabilityId}`);
  }
  await triggerFlowBackedBinaryControlRequest({
    deviceId,
    name,
    capabilityId,
    desired,
    logContext,
    actuationMode,
  });
  structuredLog?.info({
    event: 'flow_backed_binary_command_requested',
    deviceId,
    deviceName: name,
    capabilityId,
    desired,
    logContext,
    actuationMode,
  });
}

function buildBinaryControlSuccessLogMessage(params: {
  controlPlan: BinaryControlPlan;
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
  flowBackedControl: boolean;
}): string {
  const {
    controlPlan,
    logContext,
    desired,
    name,
    reason,
    restoreSource,
    actuationMode,
    flowBackedControl,
  } = params;
  if (flowBackedControl) {
    return controlPlan.isEv
      ? buildFlowBackedEvBinaryControlRequestLogMessage(logContext, desired, name, reason, actuationMode)
      : buildFlowBackedBinaryControlRequestLogMessage({
        logContext,
        desired,
        name,
        reason,
        restoreSource,
        actuationMode,
      });
  }
  return controlPlan.isEv
    ? buildEvBinaryControlLogMessage(logContext, desired, name, reason, actuationMode)
    : buildBinaryControlLogMessage({ logContext, desired, name, reason, restoreSource, actuationMode });
}

function buildBinaryControlFailureLogMessage(params: {
  controlPlan: BinaryControlPlan;
  desired: boolean;
  name: string;
  flowBackedControl: boolean;
}): string {
  const { controlPlan, desired, name, flowBackedControl } = params;
  const verb = controlPlan.isEv
    ? `${desired ? 'resume' : 'pause'} EV charging for`
    : `${desired ? 'turn on' : 'turn off'}`;
  return flowBackedControl
    ? `Failed to request ${verb} ${name} via flow`
    : `Failed to ${verb} ${name} via DeviceManager`;
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
  binarySettleEvidenceByDeviceId?: BinarySettleEvidenceByDeviceId;
  logDebug: (message: string) => void;
  onConfirmed?: (params: {
    deviceId: string;
    liveDevice: PlanInputDevice;
    pending: PlanEngineState['pendingBinaryCommands'][string];
    source: PendingTargetObservationSource;
    confirmedAtMs: number;
  }) => void;
}): boolean {
  const {
    state,
    liveDevices,
    binarySettleEvidenceByDeviceId,
    logDebug,
    onConfirmed,
  } = params;
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  const nowMs = Date.now();
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingBinaryCommands)) {
    const liveDevice = liveById.get(deviceId);
    if (!isPendingBinaryCommandActive({
      pending,
      nowMs,
      communicationModel: liveDevice?.communicationModel,
    })) {
      clearTimedOutPendingBinaryCommand({ state, deviceId, pending, liveDevice, nowMs, logDebug });
      changed = true;
      continue;
    }
    if (!liveDevice) continue;

    const evidence = getMatchingBinarySettleEvidence(binarySettleEvidenceByDeviceId, deviceId, pending);
    if (!evidence) continue;
    changed = applyBinarySettleEvidence({
      state,
      deviceId,
      liveDevice,
      pending,
      evidence,
      nowMs,
      logDebug,
      onConfirmed,
    }) || changed;
  }

  return changed;
}
