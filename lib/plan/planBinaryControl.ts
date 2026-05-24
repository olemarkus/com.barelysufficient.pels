import type { DeviceManager } from '../device/manager';
import type { DeviceObservation } from '../device/deviceObservation';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanEngineState } from './planState';
import { resolveBinaryCommandPendingMs } from './planObservationPolicy';
import { getLogger } from '../logging/logger';
import {
  buildFlowBackedBinaryControlRequestLogMessage,
  buildFlowBackedEvBinaryControlRequestLogMessage,
  resolveBinaryRestoreSuffix,
  type BinaryControlActuationMode,
  type BinaryControlLogContext,
  type BinaryControlPlan,
  type BinaryControlRestoreSource,
  formatEvSnapshot,
  isFlowBackedBinaryControl,
  shouldSkipBinaryControl,
} from './planBinaryControlHelpers';

export { formatEvSnapshot, isFlowBackedBinaryControl } from './planBinaryControlHelpers';

const logger = getLogger('plan/binary-control');

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
    state, deviceManager, triggerFlowBackedBinaryControlRequest,
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
    name,
    snapshot,
    state,
  })) {
    return false;
  }
  if (!controlPlan) return false;

  if (controlPlan.isEv) {
    logger.debug({
      event: 'ev_action_requested',
      deviceId,
      deviceName: name,
      capabilityId: controlPlan.capabilityId,
      desired,
      evSnapshot: formatEvSnapshot(snapshot),
      ...(reason ? { reason } : {}),
    });
  }

  return executeBinaryCommand({
    state, deviceManager, triggerFlowBackedBinaryControlRequest,
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
    state, deviceManager, triggerFlowBackedBinaryControlRequest,
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
    await dispatchBinaryCommand({
      flowBackedControl, triggerFlowBackedBinaryControlRequest, deviceManager,
      deviceId, name, capabilityId: controlPlan.capabilityId, desired, logContext, actuationMode,
    });
    emitBinaryCommandSuccess({
      controlPlan, deviceManager, flowBackedControl, deviceId, name, desired,
      logContext, restoreSource, reason, actuationMode,
    });
    return true;
  } catch (caughtError) {
    delete state.pendingBinaryCommands[deviceId];
    emitBinaryCommandFailure({
      controlPlan, flowBackedControl, deviceId, name, desired, logContext,
      restoreSource, reason, actuationMode, err: caughtError,
    });
    return false;
  }
}

async function dispatchBinaryCommand(params: {
  flowBackedControl: boolean;
  triggerFlowBackedBinaryControlRequest?: BinaryControlDeps['triggerFlowBackedBinaryControlRequest'];
  deviceManager: DeviceManager;
  deviceId: string;
  name: string;
  capabilityId: BinaryControlPlan['capabilityId'];
  desired: boolean;
  logContext: BinaryControlLogContext;
  actuationMode: BinaryControlActuationMode;
}): Promise<void> {
  if (params.flowBackedControl) {
    await requestFlowBackedBinaryControl({
      triggerFlowBackedBinaryControlRequest: params.triggerFlowBackedBinaryControlRequest,
      deviceId: params.deviceId,
      name: params.name,
      capabilityId: params.capabilityId,
      desired: params.desired,
      logContext: params.logContext,
      actuationMode: params.actuationMode,
    });
    return;
  }
  await params.deviceManager.setCapability(params.deviceId, params.capabilityId, params.desired);
}

function emitBinaryCommandSuccess(params: {
  controlPlan: BinaryControlPlan;
  deviceManager: DeviceObservation;
  flowBackedControl: boolean;
  deviceId: string;
  name: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode: BinaryControlActuationMode;
}): void {
  const {
    controlPlan, deviceManager, flowBackedControl, deviceId, name, desired,
    logContext, restoreSource, reason, actuationMode,
  } = params;
  logger.info({
    event: flowBackedControl ? 'flow_backed_binary_command_succeeded' : 'binary_command_succeeded',
    deviceId,
    deviceName: name,
    capabilityId: controlPlan.capabilityId,
    desired,
    logContext,
    actuationMode,
    ...(restoreSource ? { restoreSource } : {}),
    ...(reason ? { reason } : {}),
    msg: buildBinaryControlSuccessLogMessage({
      controlPlan, logContext, desired, name, reason, restoreSource, actuationMode, flowBackedControl,
    }),
  });
  if (!controlPlan.isEv) return;
  logger.debug({
    event: flowBackedControl ? 'ev_action_requested_via_flow' : 'ev_action_completed',
    deviceId,
    deviceName: name,
    capabilityId: controlPlan.capabilityId,
    desired,
    evSnapshot: formatEvSnapshot(deviceManager.getSnapshotByDeviceId(deviceId)),
  });
}

function emitBinaryCommandFailure(params: {
  controlPlan: BinaryControlPlan;
  flowBackedControl: boolean;
  deviceId: string;
  name: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode: BinaryControlActuationMode;
  err: unknown;
}): void {
  const {
    controlPlan, flowBackedControl, deviceId, name, desired,
    logContext, restoreSource, reason, actuationMode, err,
  } = params;
  logger.error({
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
    err,
    msg: buildBinaryControlFailureLogMessage({ controlPlan, desired, name, flowBackedControl }),
  });
}

async function requestFlowBackedBinaryControl(params: {
  triggerFlowBackedBinaryControlRequest?: BinaryControlDeps['triggerFlowBackedBinaryControlRequest'];
  deviceId: string;
  name: string;
  capabilityId: 'onoff' | 'evcharger_charging';
  desired: boolean;
  logContext: BinaryControlLogContext;
  actuationMode: BinaryControlActuationMode;
}): Promise<void> {
  const {
    triggerFlowBackedBinaryControlRequest,
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
  logger.info({
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

export { syncPendingBinaryCommands } from './planBinaryControlSync';
