import type { DeviceObservation } from '../device/deviceObservation';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanEngineState } from './planState';
import { resolveBinaryCommandPendingMs } from './planObservationPolicy';
import { getLogger } from '../logging/logger';
import {
  type BinaryControlActuationMode,
  type BinaryControlDecision,
  type BinaryControlLogContext,
  type BinaryControlPlan,
  type BinaryControlRestoreSource,
  formatEvSnapshot,
  isFlowBackedBinaryControl,
  shouldSkipBinaryControl,
} from './planBinaryControlHelpers';

export {
  formatEvSnapshot,
  isFlowBackedBinaryControl,
  type BinaryControlDecision,
} from './planBinaryControlHelpers';

const logger = getLogger('plan/binary-control');

type BinaryControlDeps = {
  state: PlanEngineState;
  deviceObservation: DeviceObservation;
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

/**
 * Decide whether the device should actuate this cycle.
 *
 * Returns the populated `BinaryControlDecision` and records the matching
 * `pendingBinaryCommands` entry on the engine state when the decision is
 * to actuate. Returns `null` when the device should be skipped (already
 * matched, pending, or lacks a setable control plan); pending state is
 * not touched in the skip case.
 *
 * Callers must hand the returned decision to
 * `dispatchBinaryControlDecision` (executor); the dispatcher will clear
 * the pending entry on failure and emit success/failure logs.
 */
export function decideBinaryControl(params: BinaryControlDeps & {
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode?: BinaryControlActuationMode;
}): BinaryControlDecision | null {
  const {
    state, deviceObservation,
    deviceId, name, desired, snapshot, logContext, restoreSource, reason,
    actuationMode = 'plan',
  } = params;
  const controlPlan = getBinaryControlPlan(snapshot);
  if (shouldSkipBinaryControl({
    controlPlan,
    deviceManager: deviceObservation,
    deviceId,
    desired,
    logContext,
    actuationMode,
    name,
    snapshot,
    state,
  })) {
    return null;
  }
  if (!controlPlan) return null;

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

  const flowBackedControl = isFlowBackedBinaryControl(snapshot, controlPlan.capabilityId);
  const pendingMs = resolveBinaryCommandPendingMs(snapshot?.communicationModel);

  // Plan owns pending bookkeeping; record before handing the decision to
  // the executor so the failure path can clear it back out.
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

  return {
    deviceId,
    name,
    capabilityId: controlPlan.capabilityId,
    desired,
    flowBackedControl,
    logContext,
    actuationMode,
    restoreSource,
    reason,
    isEv: controlPlan.isEv,
  };
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

export { syncPendingBinaryCommands } from './planBinaryControlSync';
