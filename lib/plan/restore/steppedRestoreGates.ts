import type { DevicePlanDevice } from '../planTypes';
import type { RestoreTiming } from './timing';
import type { PlanEngineState } from '../planState';
import type { StructuredDebugEmitter } from '../../logging/logger';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';
import {
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
} from './timing';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { hasOtherDevicesBlockingSteppedRestore } from './coordination';
import { buildMeterSettlingReason } from '../planReasonStrings';
import {
  buildOffSteppedRestoreHoldUpdate,
  buildOffSteppedRestoreShedUpdate,
  setRestorePlanDevice,
} from './planDeviceUpdates';

export type SteppedDeviceGateTiming = Pick<RestoreTiming,
| 'activeOvershoot'
| 'inCooldown'
| 'inRestoreCooldown'
| 'inStartupStabilization'
| 'measurementTs'
| 'nowTs'
| 'restoreCooldownSeconds'
| 'restoreCooldownMs'
| 'shedCooldownRemainingSec'
| 'restoreCooldownRemainingSec'
| 'startupStabilizationRemainingSec'
>;

// Returns true if a gate fired and planRestoreForSteppedDevice should return early.
// Encapsulates meter-settling and capacity-block gate checks, applying global gates only
// to OFF devices and per-device settling to active devices.
export function applySteppedDeviceGates(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  timing: SteppedDeviceGateTiming;
  deviceIsActive: boolean;
  restoredOneThisCycle: boolean;
  restoreDebugKey: string;
  availableHeadroom: number;
  phase: 'startup' | 'runtime';
  requestedStepId: string | null;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    dev,
    deviceMap,
    state,
    timing,
    deviceIsActive,
    restoredOneThisCycle,
    restoreDebugKey,
    availableHeadroom,
    phase,
    requestedStepId,
    debugStructured,
  } = params;
  const lastRestoreTs = deviceIsActive
    ? (state.lastDeviceRestoreMs[dev.id] ?? null)
    : state.lastRestoreMs;
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing, lastRestoreTs, restoredOneThisCycle,
  });
  if (meterSettlingRemainingSec !== null) {
    const reason = buildMeterSettlingReason(
      meterSettlingRemainingSec,
      resolveMeterSettlingCountdownTiming({ timing, lastRestoreTs, restoredOneThisCycle }),
    );
    setRestorePlanDevice(deviceMap, dev.id,
      deviceIsActive ? { reason } : buildOffSteppedRestoreHoldUpdate(dev, reason),
    );
    emitSteppedRestoreGateRejection({
      dev,
      state,
      restoreDebugKey,
      phase,
      reason,
      rejectionReason: 'meter_settling',
      availableHeadroom,
      requestedStepId,
      debugStructured,
    });
    return true;
  }
  const gateTiming = deviceIsActive
    ? { ...timing, inRestoreCooldown: false as const, inCooldown: false as const }
    : timing;
  const gateReason = resolveCapacityRestoreBlockReason({ timing: gateTiming, restoredOneThisCycle });
  if (gateReason) {
    setRestorePlanDevice(deviceMap, dev.id, deviceIsActive
      ? { reason: gateReason }
      : { ...buildOffSteppedRestoreShedUpdate(dev), reason: gateReason });
    emitSteppedRestoreGateRejection({
      dev,
      state,
      restoreDebugKey,
      phase,
      reason: gateReason,
      rejectionReason: 'restore_gate',
      availableHeadroom,
      requestedStepId,
      debugStructured,
    });
    return true;
  }
  const waitingForOtherRecovery = deviceIsActive
    && hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.shedDecidedMs);
  const waitingReason = resolveCapacityRestoreBlockReason({
    timing: gateTiming,
    waitingForOtherRecovery,
  });
  if (waitingReason) {
    setRestorePlanDevice(deviceMap, dev.id, deviceIsActive
      ? { reason: waitingReason }
      : { ...buildOffSteppedRestoreShedUpdate(dev), reason: waitingReason });
    emitSteppedRestoreGateRejection({
      dev,
      state,
      restoreDebugKey,
      phase,
      reason: waitingReason,
      rejectionReason: 'waiting_for_other_recovery',
      availableHeadroom,
      requestedStepId,
      debugStructured,
    });
    return true;
  }
  return false;
}

function emitSteppedRestoreGateRejection(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  restoreDebugKey: string;
  phase: 'startup' | 'runtime';
  reason: DevicePlanDevice['reason'];
  rejectionReason: 'meter_settling' | 'restore_gate' | 'waiting_for_other_recovery';
  availableHeadroom: number;
  requestedStepId: string | null;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const {
    dev,
    state,
    restoreDebugKey,
    phase,
    reason,
    rejectionReason,
    availableHeadroom,
    requestedStepId,
    debugStructured,
  } = params;
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId ?? 'unknown',
      requestedStepId: requestedStepId ?? undefined,
      reason: formatDeviceReason(reason),
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
    },
    signaturePayload: {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId ?? 'unknown',
      requestedStepId: requestedStepId ?? undefined,
      reason: buildComparableDeviceReason(reason),
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
    },
    debugStructured,
  });
}
