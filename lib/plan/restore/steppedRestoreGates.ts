import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import type { RestoreTiming } from './timing';
import type { PlanEngineState } from '../planState';
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
  dev: SteppedPlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  timing: SteppedDeviceGateTiming;
  deviceIsActive: boolean;
  restoredOneThisCycle: boolean;
  restoreDebugKey: string;
  availableHeadroom: number;
  phase: 'startup' | 'runtime';
  requestedStepId: string | null;
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
  } = params;
  const lastRestoreTs = deviceIsActive
    ? (state.actuation.lastDeviceRestoreMs[dev.id] ?? null)
    : state.actuation.lastRestoreMs;
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing, lastRestoreTs, restoredOneThisCycle,
  });
  if (meterSettlingRemainingSec !== null) {
    const reason = buildMeterSettlingReason(
      meterSettlingRemainingSec,
      resolveMeterSettlingCountdownTiming({
        timing, lastRestoreTs, restoredOneThisCycle,
      }),
    );
    setRestorePlanDevice(deviceMap, dev.id,
      deviceIsActive ? { reason } : buildOffSteppedRestoreHoldUpdate(dev, reason),
    );
    emitSteppedRestoreGateRejection({
      dev,
      state,
      restoreDebugKey,
      phase,
      rejectionReason: 'meter_settling',

      availableHeadroom,
      requestedStepId,
    });
    return true;
  }
  const gateTiming = deviceIsActive
    ? { ...timing, inRestoreCooldown: false as const, inCooldown: false as const }
    : timing;
  const gateReason = resolveCapacityRestoreBlockReason({
    timing: gateTiming,
    restoredOneThisCycle,
  });
  if (gateReason) {
    setRestorePlanDevice(deviceMap, dev.id, deviceIsActive
      ? { reason: gateReason }
      : { ...buildOffSteppedRestoreShedUpdate(dev), reason: gateReason });
    emitSteppedRestoreGateRejection({
      dev,
      state,
      restoreDebugKey,
      phase,
      rejectionReason: 'restore_gate',

      availableHeadroom,
      requestedStepId,
    });
    return true;
  }
  const waitingForOtherRecovery = deviceIsActive
    && hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.shedDecisions.decidedMs);
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
      rejectionReason: 'waiting_for_other_recovery',

      availableHeadroom,
      requestedStepId,
    });
    return true;
  }
  return false;
}

function emitSteppedRestoreGateRejection(params: {
  dev: SteppedPlanDevice;
  state: PlanEngineState;
  restoreDebugKey: string;
  phase: 'startup' | 'runtime';
  rejectionReason: 'meter_settling' | 'restore_gate' | 'waiting_for_other_recovery';
  availableHeadroom: number;
  requestedStepId: string | null;
}): void {
  const {
    dev,
    state,
    restoreDebugKey,
    phase,
    rejectionReason,
    availableHeadroom,
    requestedStepId,
  } = params;
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: requestedStepId ?? undefined,
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
    },
  });
}
