import type { DevicePlanDevice, MeteredKind, SteppedPlanDevice } from '../planTypes';
import { resolveSurplusCeilingStepId, type PlanEngineState } from '../planState';
import {
  getSteppedRestoreCandidates,
  isOffSteppedRestoreCandidate,
  NEUTRAL_STARTUP_HOLD_REASON,
  resolveInactiveRestoreUpdate,
} from './devices';
import { resolveCapacityRestoreBlockReason } from './timing';
import {
  getSteppedLoadNextRestoreStep,
  resolveStepChangeKw,
} from '../planSteppedLoad';
import { getSteppedLoadStep } from '../../../packages/shared-domain/src/deviceControlProfiles';
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
import { computeRestoreBufferKw } from './accounting';
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
  emitRestoreDebugEventOnChange({
    state,
    key: `setback:${stepped ? 'stepped' : 'binary'}:${deviceId}`,
    payload: {
      event: 'restore_blocked_setback',
      deviceId,
      deviceName: dev.name,
      penaltyLevel: getActivationPenaltyLevel(state, deviceId),
      remainingMs,
      stepped,
    },
  });
  return true;
}

/**
 * Answers the restore step if it may be taken, or null. Null for a
 * surplus-TRACKING device whose next rung sits above the one this cycle's solar
 * allocation bought it; the step unchanged for every other device.
 *
 * The ceiling has to be enforced here as well as on the keep path, because
 * restore is a separate lane that decides from grid HEADROOM rather than from
 * the surplus pool — without this it would silently undo the ceiling every
 * cycle. A boosted device passes: a boost is a live demand that outranks "use
 * only your own sun", the same call `resolveSteppedKeepDesiredStepId` makes.
 */
function admitStepUnderSurplusCeiling<T extends { id: string; planningPowerW: number }>(
  dev: SteppedPlanDevice,
  state: PlanEngineState,
  nextStep: T | null,
): T | null {
  if (!nextStep) return null;
  if (!dev.surplusTracking) return nextStep;
  if (dev.boostActive) return nextStep;
  const ceilingStepId = resolveSurplusCeilingStepId(state, dev.id);
  if (ceilingStepId === undefined) return nextStep;
  const ceilingStep = getSteppedLoadStep(dev.steppedLoadProfile, ceilingStepId);
  if (!ceilingStep) return nextStep;
  return nextStep.planningPowerW <= ceilingStep.planningPowerW ? nextStep : null;
}

/**
 * The draw a restore climb commits, in kW.
 *
 * The price itself comes from `resolveStepChangeKw`, which serves both lanes;
 * this only says what a non-climb means HERE. A descent belongs to shedding,
 * and a step that goes nowhere adds no draw — both are nothing for the restore
 * lane to admit.
 */
function resolveSteppedRestoreCommitmentKw(
  dev: SteppedPlanDevice & MeteredKind,
  toStepId: string,
): number {
  const change = resolveStepChangeKw(dev, dev.selectedStepId, toStepId);
  return change.direction === 'up' ? change.deltaKw : 0;
}

function resolveSteppedRestoreNeed(
  dev: SteppedPlanDevice & MeteredKind,
  nextStep: { id: string } | null,
): SteppedRestoreNeed {
  if (!nextStep) return { deltaKw: 0, neededKw: 0 };
  const deltaKw = resolveSteppedRestoreCommitmentKw(dev, nextStep.id);
  if (deltaKw <= 0) return { deltaKw, neededKw: 0 };
  return { deltaKw, neededKw: deltaKw + computeRestoreBufferKw(deltaKw) };
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

  const requestedStep = getSteppedLoadNextRestoreStep(dev);
  // The gates below see the step the ladder WANTED — that is what their logging
  // and admission are about — while `nextStep` is the step the surplus ceiling
  // actually admits, and drives everything after it.
  const nextStep = admitStepUnderSurplusCeiling(dev, state, requestedStep);
  const restoreNeed = resolveSteppedRestoreNeed(dev, nextStep);
  const batchContinuation = canContinueShedPostureRestoreBatch(
    batchState,
    state.shedDecisions,
    dev.id,
    loop.restoredOneThisCycle,
    restoreNeed.neededKw,
  );
  if (applySteppedDeviceGates(cycle, dev, loop, batchContinuation, requestedStep?.id ?? null)) return loop;

  if (blockRestoreForRecentActivationSetback(cycle, dev, true)) return loop;

  if (!nextStep || restoreNeed.deltaKw <= 0) {
    clearRestoreDebugEvent(state, `stepped:${dev.id}`);
    return loop;
  }

  const attemptHold = applySteppedRestoreAttemptHold(cycle, dev, loop, nextStep);
  if (attemptHold.kind !== 'not_handled') {
    return commitSteppedRestoreAttempt(batchState, state, dev, restoreNeed, attemptHold);
  }

  if (blockSteppedRestoreForShedInvariant(cycle, dev, nextStep)) return loop;
  delete state.steppedRestoreRejectedByDevice[dev.id];

  return admitSteppedRestore(cycle, lane, dev, loop, nextStep, restoreNeed, batchContinuation);
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
