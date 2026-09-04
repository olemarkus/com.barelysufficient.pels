import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import type { RestoreTiming } from './timing';
import { resolveSurplusCeilingStepId, type PlanEngineState } from '../planState';
import type { StructuredDebugEmitter } from '../../logging/logger';
import {
  getInactiveReason,
  getSteppedRestoreCandidates,
  isActiveSteppedRestoreCandidate,
  isOffSteppedRestoreCandidate,
  NEUTRAL_STARTUP_HOLD_REASON,
} from './devices';
import { resolveCapacityRestoreBlockReason } from './timing';
import {
  getSteppedLoadNextRestoreStep,
  isSteppedLoadDevice,
  resolveStepChangeKw,
} from '../planSteppedLoad';
import { getSteppedLoadLowestActiveStep, getSteppedLoadStep } from '../../utils/deviceControlProfiles';
import {
  getActivationPenaltyLevel,
  getActivationRestoreBlockCountdownTiming,
  getActivationRestoreBlockRemainingMs,
} from '../admission';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { countShedDevices } from './coordination';
import { resolveRestoreDecisionPhase } from '../admission';
import { buildActivationBackoffReason } from '../planReasonStrings';
import { applySteppedRestoreAttemptHold } from '../planSteppedRestoreHold';
import { setRestorePlanDevice } from './planDeviceUpdates';
import { applySteppedDeviceGates } from './steppedRestoreGates';
import {
  admitSteppedRestore,
  blockSteppedRestoreForShedInvariant,
  type SteppedSwapExecutor,
} from './steppedRestoreAdmission';
import type { HeadroomReserve } from '../admission';
import type { RestoreAdmissionMode, RestoreDeviceTiming } from './types';
import { preservePreviewAdmission } from './cooldownPreview';

// Re-export the public restore-helper surface so existing importers
// (lib/plan/restore/index.ts, lib/plan/swap/blocking.ts, tests) are unchanged
// while the implementation lives in cohesive sibling modules.
export { setRestorePlanDevice, buildOffSteppedRestoreShedUpdate } from './planDeviceUpdates';
export type { SteppedSwapExecutor } from './steppedRestoreAdmission';

export function markSteppedDevicesStayAtCurrentLevel(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: Pick<RestoreTiming,
  | 'activeOvershoot'
  | 'inCooldown'
  | 'inRestoreCooldown'
  | 'inStartupStabilization'
  | 'measurementTs'
  | 'nowTs'
  | 'restoreCooldownSeconds'
  | 'restoreCooldownMs'
  | 'shedCooldownRemainingSec'
  | 'shedCooldownStartedAtMs'
  | 'shedCooldownTotalSec'
  | 'restoreCooldownRemainingSec'
  | 'restoreCooldownStartedAtMs'
  | 'restoreCooldownTotalSec'
  | 'startupStabilizationRemainingSec'>;
  currentOffPlannedState?: 'shed' | 'keep';
  getLastControlledMs?: (deviceId: string) => number | undefined;
  deviceFilter?: (dev: DevicePlanDevice) => boolean;
}): void {
  const {
    deviceMap,
    timing,
    currentOffPlannedState = 'shed',
    getLastControlledMs,
    deviceFilter,
  } = params;
  const steppedDevices = getSteppedRestoreCandidates(Array.from(deviceMap.values()))
    .filter((dev) => deviceFilter?.(dev) ?? true);
  for (const dev of steppedDevices) {
    // "Off" here must use the SAME step-axis resolution as the candidacy filter:
    // a step-only stepped device (no binary handle) parked at its off step is off
    // too. A binary-only `!currentOn` check would skip the cooldown/startup hold
    // for such a device, letting the executor step a `keep`-normalised load back
    // up during a restore-blocked window without admission.
    const currentOff = isOffSteppedRestoreCandidate(dev);
    const neverControlledStartupHold = timing.inStartupStabilization
      && currentOff
      && getLastControlledMs?.(dev.id) === undefined;
    if (neverControlledStartupHold) {
      setRestorePlanDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      });
      continue;
    }
    const reason = resolveCapacityRestoreBlockReason({
      timing,
      showStartupStabilization: getLastControlledMs ? getLastControlledMs(dev.id) !== undefined : true,
    });
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
      currentOff ? { plannedState: currentOffPlannedState, reason } : { reason },
    );
  }
}

export function blockRestoreForRecentActivationSetback(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  deviceId: string;
  deviceName: string | undefined;
  state: PlanEngineState;
  stepped: boolean;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    deviceMap,
    deviceId,
    deviceName,
    state,
    stepped,
    debugStructured,
  } = params;
  const remainingMs = getActivationRestoreBlockRemainingMs({ state, deviceId });
  if (remainingMs === null) return false;
  const reason = buildActivationBackoffReason(
    remainingMs,
    getActivationRestoreBlockCountdownTiming({ state, deviceId }),
  );
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
      deviceName,
      penaltyLevel: getActivationPenaltyLevel(state, deviceId),
      remainingMs,
      stepped,
    },
    debugStructured,
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
  if (dev.boostActive === true) return nextStep;
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
  dev: SteppedPlanDevice,
  toStepId: string,
): number {
  const change = resolveStepChangeKw(dev, dev.selectedStepId, toStepId);
  return change.direction === 'up' ? change.deltaKw : 0;
}

export function planRestoreForSteppedDevice(params: {
  dev: SteppedPlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  timing: RestoreDeviceTiming;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  debugStructured?: StructuredDebugEmitter;
  swapExecutor?: SteppedSwapExecutor;
  headroomReserves?: readonly HeadroomReserve[];
  admissionMode?: RestoreAdmissionMode;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, timing, availableHeadroom, restoredOneThisCycle,
    debugStructured, swapExecutor, headroomReserves = [],
    admissionMode = { kind: 'apply' } } = params;
  const restoreDebugKey = `stepped:${dev.id}`;
  if (keepInactiveSteppedDeviceInactive({
    dev,
    deviceMap,
    state,
    restoreDebugKey,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (countShedDevices(deviceMap, dev.id) === 0) {
    delete state.steppedRestoreRejectedByDevice[dev.id];
  }

  const phase = resolveRestoreDecisionPhase(state.currentRebuildTrigger);
  // Active stepped devices (ON but below their target step) must not be blocked by the global
  // restore cooldown or meter-settling gate — per-device restore timing still applies. Resolve
  // "active" via the step axis so a step-only stepper (no binary handle) is recognised too.
  const deviceIsActive = isActiveSteppedRestoreCandidate(dev);
  const requestedStep = getSteppedLoadNextRestoreStep(dev);
  // The gates below see the step the ladder WANTED — that is what their logging
  // and admission are about — while `nextStep` is the step the surplus ceiling
  // actually admits, and drives everything after it.
  const nextStep = admitStepUnderSurplusCeiling(dev, state, requestedStep);
  if (applySteppedDeviceGates({
    dev,
    deviceMap,
    state,
    timing,
    deviceIsActive,
    restoredOneThisCycle,
    restoreDebugKey,
    availableHeadroom,
    phase,
    requestedStepId: requestedStep?.id ?? null,
    debugStructured,
    admissionMode,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (blockRestoreForRecentActivationSetback({
    deviceMap, deviceId: dev.id, deviceName: dev.name, state, stepped: true, debugStructured,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (!nextStep) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const lowestNonZeroStep = isSteppedLoadDevice(dev)
    ? getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)
    : null;
  const deltaKw = resolveSteppedRestoreCommitmentKw(dev, nextStep.id);
  if (deltaKw <= 0) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }
  const attemptHold = applySteppedRestoreAttemptHold({
    dev,
    nextStepId: nextStep.id,
    nextStepPowerKw: nextStep.planningPowerW / 1000,
    lastRestoreMs: state.lastDeviceRestoreMs[dev.id],
    measurementTs: typeof timing.measurementTs === 'number' ? timing.measurementTs : null,
    phase,
    state,
    restoreDebugKey,
    debugStructured,
    availableHeadroom,
    restoredOneThisCycle,
    setDevice: (updates) => setRestorePlanDevice(deviceMap, dev.id, updates),
  });
  if (attemptHold.handled) {
    return {
      availableHeadroom: attemptHold.availableHeadroom,
      restoredOneThisCycle: attemptHold.restoredOneThisCycle,
    };
  }

  if (blockSteppedRestoreForShedInvariant({
    dev, deviceMap, state, nextStep, lowestNonZeroStep, phase, debugStructured, restoreDebugKey,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }
  delete state.steppedRestoreRejectedByDevice[dev.id];

  const result = admitSteppedRestore({
    dev,
    deviceMap,
    state,
    phase,
    nextStep,
    lowestNonZeroStep,
    deltaKw,
    availableHeadroom,
    debugStructured,
    restoreDebugKey,
    swapExecutor,
    headroomReserves,
    restoredOneThisCycle,
    admissionMode,
  });
  return preservePreviewAdmission(result, admissionMode, restoredOneThisCycle);
}

function keepInactiveSteppedDeviceInactive(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  restoreDebugKey: string;
}): boolean {
  const inactiveReason = getInactiveReason(params.dev);
  if (!inactiveReason) return false;
  clearRestoreDebugEvent(params.state, params.restoreDebugKey);
  setRestorePlanDevice(params.deviceMap, params.dev.id, {
    plannedState: 'inactive',
    reason: inactiveReason,
  });
  return true;
}
