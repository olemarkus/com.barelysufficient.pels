import type { DevicePlanDevice, MeteredKind, SteppedPlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import {
  getSteppedRestoreCandidates,
  isOffSteppedRestoreCandidate,
  NEUTRAL_STARTUP_HOLD_REASON,
  resolveInactiveRestoreUpdate,
} from './devices';
import { resolveCapacityRestoreBlockReason } from './timing';
import {
  getActivationPenaltyLevel,
  resolveActivationRestoreBlock,
} from '../admission';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { countShedDevices } from './coordination';
import { buildActivationBackoffReason } from '../planReasonStrings';
import {
  applySteppedRestoreAttemptHold,
  type SteppedRestoreAttemptHold,
} from '../planSteppedRestoreHold';
import { setRestorePlanDevice } from './planDeviceUpdates';
import { applySteppedDeviceGates } from './steppedRestoreGates';
import {
  canContinueShedPostureRestoreBatch,
  recordShedPostureRestoreBatchAdmission,
} from './batch';
import { resolveSteppedRestoreTarget } from './steppedRestoreTarget';
import { getSteppedLoadNextRestoreStep } from '../planSteppedLoad';
import {
  admitSteppedRestore,
  blockSteppedRestoreForShedInvariant,
} from './steppedRestoreAdmission';
import type {
  RestoreBatchState,
  RestoreCycle,
  RestoreLane,
  RestoreLoopState,
  SteppedRestoreNeed,
} from './types';

// Re-export the public restore-helper surface so existing importers
// (lib/plan/restore/index.ts, lib/plan/restore/gating.ts, tests) are unchanged
// while the implementation lives in cohesive sibling modules.
export { setRestorePlanDevice } from './planDeviceUpdates';

export function markSteppedDevicesStayAtCurrentLevel(
  cycle: RestoreCycle,
  deviceFilter?: (dev: DevicePlanDevice) => boolean,
): void {
  const { deviceMap, timing, state } = cycle;
  const steppedDevices = getSteppedRestoreCandidates(Array.from(deviceMap.values()))
    .filter((dev) => deviceFilter?.(dev) ?? true);
  for (const dev of steppedDevices) {
    // "Off" here must use the SAME step-axis resolution as the candidacy filter:
    // a step-only stepped device (no binary handle) parked at its off step is off
    // too. A binary-only `!currentOn` check would skip the cooldown/startup hold
    // for such a device, letting the executor step a `keep`-normalised load back
    // up during a restore-blocked window without admission.
    const currentOff = isOffSteppedRestoreCandidate(dev);
    const lastControlledMs = state.actuation.lastDeviceControlledMs[dev.id];
    const neverControlledStartupHold = timing.inStartupStabilization
      && currentOff
      && lastControlledMs === undefined;
    if (neverControlledStartupHold) {
      setRestorePlanDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      });
      continue;
    }
    const reason = resolveCapacityRestoreBlockReason(timing, null, lastControlledMs !== undefined);
    if (!reason) {
      if (!currentOff) continue;
      setRestorePlanDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      });
      continue;
    }
    setRestorePlanDevice(
      deviceMap,
      dev.id,
      currentOff ? { plannedState: 'shed', reason } : { reason },
    );
  }
}

export function blockRestoreForRecentActivationSetback(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  stepped: boolean,
): boolean {
  const { deviceMap, state } = cycle;
  const deviceId = dev.id;
  const block = resolveActivationRestoreBlock(state, deviceId, cycle.timing.nowTs);
  if (block === null) return false;
  const { remainingMs } = block;
  const reason = buildActivationBackoffReason(remainingMs, block);
  if (stepped) {
    setRestorePlanDevice(deviceMap, deviceId, { reason });
  } else {
    setRestorePlanDevice(deviceMap, deviceId, {
      plannedState: 'shed',
      reason,
    });
  }
  emitRestoreDebugEventOnChange(state, `setback:${stepped ? 'stepped' : 'binary'}:${deviceId}`, {
    event: 'restore_blocked_setback',
    deviceId,
    deviceName: dev.name,
    penaltyLevel: getActivationPenaltyLevel(state, deviceId),
    remainingMs,
    stepped,
  });
  return true;
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function planRestoreForSteppedDevice(
  cycle: RestoreCycle,
  lane: RestoreLane,
  dev: SteppedPlanDevice & MeteredKind,
  loop: RestoreLoopState,
): RestoreLoopState {
  const { deviceMap, state, batchState } = cycle;
  if (keepInactiveSteppedDeviceInactive(cycle, dev)) return loop;

  if (countShedDevices(deviceMap, dev.id, state.shedDecisions) === 0) {
    delete state.steppedRestoreRejectedByDevice[dev.id];
  }

  const target = resolveSteppedRestoreTarget(cycle, dev, loop);
  const batchContinuation = canContinueShedPostureRestoreBatch(
    batchState,
    state.shedDecisions,
    dev.id,
    loop.restoredOneThisCycle,
    target?.need.neededKw ?? 0,
  );
  // The gates see the step the ladder WANTED when the surplus ceiling holds it
  // back, so a held device still shows the gate's reason (a charger's recovery
  // hold among them) rather than none.
  const requestedStepId = target?.step.id ?? getSteppedLoadNextRestoreStep(dev)?.id ?? null;
  if (applySteppedDeviceGates(cycle, dev, loop, batchContinuation, requestedStepId)) return loop;

  if (blockRestoreForRecentActivationSetback(cycle, dev, true)) return loop;

  if (!target || target.need.deltaKw <= 0) {
    clearRestoreDebugEvent(state, `stepped:${dev.id}`);
    return loop;
  }

  const attemptHold = applySteppedRestoreAttemptHold(cycle, dev, loop, target.step);
  if (attemptHold.kind !== 'not_handled') {
    return commitSteppedRestoreAttempt(batchState, state, dev, target.need, attemptHold);
  }

  if (blockSteppedRestoreForShedInvariant(cycle, dev, target.step)) return loop;
  delete state.steppedRestoreRejectedByDevice[dev.id];

  return admitSteppedRestore(cycle, lane, dev, loop, target, batchContinuation);
}
/* eslint-enable functional/immutable-data */

function commitSteppedRestoreAttempt(
  batchState: RestoreBatchState,
  state: PlanEngineState,
  dev: SteppedPlanDevice,
  need: SteppedRestoreNeed,
  attemptHold: SteppedRestoreAttemptHold,
): RestoreLoopState {
  if (attemptHold.kind === 'pending') {
    recordShedPostureRestoreBatchAdmission(
      batchState,
      state.shedDecisions,
      dev.id,
      need.neededKw,
    );
  }
  return {
    availableHeadroom: attemptHold.availableHeadroom,
    restoredOneThisCycle: attemptHold.restoredOneThisCycle,
  };
}

function keepInactiveSteppedDeviceInactive(cycle: RestoreCycle, dev: DevicePlanDevice): boolean {
  const inactiveUpdate = resolveInactiveRestoreUpdate(dev);
  if (!inactiveUpdate) return false;
  clearRestoreDebugEvent(cycle.state, `stepped:${dev.id}`);
  setRestorePlanDevice(cycle.deviceMap, dev.id, inactiveUpdate);
  return true;
}
