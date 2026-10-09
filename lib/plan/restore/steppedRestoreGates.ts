import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import type { RestoreTiming } from './timing';
import type { PlanEngineState } from '../planState';
import {
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingReason,
} from './timing';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { hasOtherDevicesBlockingSteppedRestore } from './coordination';
import {
  buildOffSteppedRestoreHoldUpdate,
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
  batchContinuation: boolean;
  restoreDebugKey: string;
  availableHeadroom: number | null;
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
    batchContinuation,
    restoreDebugKey,
    availableHeadroom,
    phase,
    requestedStepId,
  } = params;
  const gateRestoredOneThisCycle = restoredOneThisCycle && !batchContinuation;
  // Every gate holds the device the same way: an active device keeps its level
  // with the gate's reason, an off one is held at its off step.
  const reject = (
    reason: DevicePlanDevice['reason'],
    rejectionReason: 'meter_settling' | 'restore_gate' | 'waiting_for_other_recovery',
  ): true => {
    setRestorePlanDevice(deviceMap, dev.id,
      deviceIsActive ? { reason } : buildOffSteppedRestoreHoldUpdate(dev, reason),
    );
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
    return true;
  };
  const lastRestoreTs = deviceIsActive
    ? (state.actuation.lastDeviceRestoreMs[dev.id] ?? null)
    : state.actuation.lastRestoreMs;
  const meterSettlingReason = resolveMeterSettlingReason(timing, lastRestoreTs, gateRestoredOneThisCycle);
  if (meterSettlingReason !== null) return reject(meterSettlingReason, 'meter_settling');
  const gateTiming = deviceIsActive
    ? { ...timing, inRestoreCooldown: false as const, inCooldown: false as const }
    : timing;
  const gateReason = resolveCapacityRestoreBlockReason({
    timing: gateTiming,
    restoredOneThisCycle: gateRestoredOneThisCycle,
  });
  if (gateReason) return reject(gateReason, 'restore_gate');
  const waitingForOtherRecovery = !batchContinuation
    && deviceIsActive
    && hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.shedDecisions);
  const waitingReason = resolveCapacityRestoreBlockReason({
    timing: gateTiming,
    waitingForOtherRecovery,
  });
  if (waitingReason) return reject(waitingReason, 'waiting_for_other_recovery');
  return false;
}
