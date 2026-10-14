import type { DevicePlanDevice, MeteredKind, SteppedPlanDevice } from '../planTypes';
import { CHARGER_STEP_RECOVERY_HOLD_MS } from '../planConstants';
import { resolveStepChangeKw } from '../planSteppedLoad';
import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import {
  buildCountdownTiming,
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

function resolveChargerStepRecoveryReason(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  requestedStepId: string | null,
): DevicePlanDevice['reason'] | null {
  if (!dev.isEvCharger || !isActiveSteppedRestoreCandidate(dev) || requestedStepId === null) return null;
  const stepChange = resolveStepChangeKw(dev, dev.selectedStepId, requestedStepId);
  if (stepChange.direction !== 'up' || stepChange.deltaKw <= 0) return null;
  const { state, timing } = cycle;
  const lastShedMs = state.actuation.lastDeviceShedMs[dev.id];
  if (lastShedMs === undefined) return null;
  const remainingMs = lastShedMs + CHARGER_STEP_RECOVERY_HOLD_MS - timing.nowTs;
  if (remainingMs <= 0) return null;
  return {
    code: PLAN_REASON_CODES.cooldownRestore,
    remainingSec: Math.ceil(remainingMs / 1000),
    ...buildCountdownTiming(lastShedMs, CHARGER_STEP_RECOVERY_HOLD_MS / 1000),
  };
}

// Returns true if a gate fired and planRestoreForSteppedDevice should return early.
// Every load increase shares the home-wide admission gate. Per-device meter
// timing additionally qualifies an active device's own previous command.
export function applySteppedDeviceGates(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  loop: RestoreLoopState,
  batchContinuation: boolean,
  requestedStepId: string | null,
): boolean {
  const { deviceMap, state, timing, phase } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  // Resolve "active" via the step axis, including a step-only device.
  const deviceIsActive = isActiveSteppedRestoreCandidate(dev);
  const gateRestoredOneThisCycle = restoredOneThisCycle && !batchContinuation;
  // Every gate holds the device the same way: an active device keeps its level
  // with the gate's reason, an off one is held at its off step.
  const reject = (
    reason: DevicePlanDevice['reason'],
    rejectionReason: 'meter_settling' | 'restore_gate' | 'waiting_for_other_recovery' | 'recent_step_down',
  ): true => {
    setRestorePlanDevice(deviceMap, dev.id,
      deviceIsActive ? { reason } : buildOffSteppedRestoreHoldUpdate(dev, reason),
    );
    const payload = {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: requestedStepId ?? undefined,
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
      ...('remainingSec' in reason ? { remainingSec: reason.remainingSec } : {}),
    };
    // Log the hold's countdown when the decision changes, rather than every meter sample.
    emitRestoreDebugEventOnChange(state, `stepped:${dev.id}`, payload, { ...payload, remainingSec: undefined });
    return true;
  };
  const lastRestoreTs = deviceIsActive
    ? (state.actuation.lastDeviceRestoreMs[dev.id] ?? null)
    : state.actuation.lastRestoreMs;
  const meterSettlingReason = resolveMeterSettlingReason(timing, lastRestoreTs, gateRestoredOneThisCycle);
  if (meterSettlingReason !== null) return reject(meterSettlingReason, 'meter_settling');
  const gateReason = resolveCapacityRestoreBlockReason(timing, inCycleRestoreWait(gateRestoredOneThisCycle), true);
  if (gateReason) return reject(gateReason, 'restore_gate');
  const waitingForOtherRecovery = !batchContinuation
    && deviceIsActive
    && hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.shedDecisions);
  const waitingReason = resolveCapacityRestoreBlockReason(timing, otherRecoveryWait(waitingForOtherRecovery), true);
  if (waitingReason) return reject(waitingReason, 'waiting_for_other_recovery');
  const recoveryReason = resolveChargerStepRecoveryReason(cycle, dev, requestedStepId);
  if (recoveryReason) return reject(recoveryReason, 'recent_step_down');
  return false;
}
