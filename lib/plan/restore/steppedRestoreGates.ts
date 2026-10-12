import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import {
  inCycleRestoreWait,
  otherRecoveryWait,
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingReason,
} from './timing';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { hasOtherDevicesBlockingSteppedRestore } from './coordination';
import { isActiveSteppedRestoreCandidate } from './devices';
import {
  buildOffSteppedRestoreHoldUpdate,
  setRestorePlanDevice,
} from './planDeviceUpdates';
import type { RestoreCycle, RestoreLoopState } from './types';

// Returns true if a gate fired and planRestoreForSteppedDevice should return early.
// Encapsulates meter-settling and capacity-block gate checks, applying global gates only
// to OFF devices and per-device settling to active devices.
export function applySteppedDeviceGates(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice,
  loop: RestoreLoopState,
  batchContinuation: boolean,
  requestedStepId: string | null,
): boolean {
  const { deviceMap, state, timing, phase } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  // Active stepped devices (ON but below their target step) must not be blocked by the global
  // restore cooldown or meter-settling gate — per-device restore timing still applies. Resolve
  // "active" via the step axis so a step-only stepper (no binary handle) is recognised too.
  const deviceIsActive = isActiveSteppedRestoreCandidate(dev);
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
    emitRestoreDebugEventOnChange(state, `stepped:${dev.id}`, {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: requestedStepId ?? undefined,
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
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
  const gateReason = resolveCapacityRestoreBlockReason(gateTiming, inCycleRestoreWait(gateRestoredOneThisCycle), true);
  if (gateReason) return reject(gateReason, 'restore_gate');
  const waitingForOtherRecovery = !batchContinuation
    && deviceIsActive
    && hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.shedDecisions);
  const waitingReason = resolveCapacityRestoreBlockReason(gateTiming, otherRecoveryWait(waitingForOtherRecovery), true);
  if (waitingReason) return reject(waitingReason, 'waiting_for_other_recovery');
  return false;
}
