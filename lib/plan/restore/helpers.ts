import type { DevicePlanDevice } from '../planTypes';
import type { RestoreTiming } from './timing';
import type { PlanEngineState } from '../planState';
import type { StructuredDebugEmitter } from '../../logging/logger';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';
import {
  getSteppedRestoreCandidates,
  isActiveSteppedRestoreCandidate,
  isOffSteppedRestoreCandidate,
  NEUTRAL_STARTUP_HOLD_REASON,
} from './devices';
import { resolveCapacityRestoreBlockReason } from './timing';
import {
  getSteppedLoadNextRestoreStep,
  isSteppedLoadDevice,
  resolveSteppedLoadRestoreDeltaKw,
} from '../planSteppedLoad';
import { getSteppedLoadLowestActiveStep } from '../../utils/deviceControlProfiles';
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
}): void {
  const {
    deviceMap,
    timing,
    currentOffPlannedState = 'shed',
    getLastControlledMs,
  } = params;
  const steppedDevices = getSteppedRestoreCandidates(Array.from(deviceMap.values()));
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
      reason: formatDeviceReason(reason),
    },
    signaturePayload: {
      event: 'restore_blocked_setback',
      deviceId,
      deviceName,
      penaltyLevel: getActivationPenaltyLevel(state, deviceId),
      stepped,
      reason: buildComparableDeviceReason(reason),
    },
    debugStructured,
  });
  return true;
}

export function planRestoreForSteppedDevice(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
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
  | 'restoreCooldownRemainingSec'
  | 'startupStabilizationRemainingSec'>;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  debugStructured?: StructuredDebugEmitter;
  swapExecutor?: SteppedSwapExecutor;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev, deviceMap, state, timing, availableHeadroom, restoredOneThisCycle, debugStructured, swapExecutor,
  } = params;
  const restoreDebugKey = `stepped:${dev.id}`;

  if (countShedDevices(deviceMap, dev.id) === 0) {
    delete state.steppedRestoreRejectedByDevice[dev.id];
  }

  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  // Active stepped devices (ON but below their target step) must not be blocked by the global
  // restore cooldown or meter-settling gate — per-device restore timing still applies. Resolve
  // "active" via the step axis so a step-only stepper (no binary handle) is recognised too.
  const deviceIsActive = isActiveSteppedRestoreCandidate(dev);
  const nextStep = getSteppedLoadNextRestoreStep(dev);
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
    requestedStepId: nextStep?.id ?? null,
    debugStructured,
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
  const deltaKw = resolveSteppedLoadRestoreDeltaKw({
    device: dev, fromStepId: dev.selectedStepId, toStepId: nextStep.id,
  });
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

  return admitSteppedRestore({
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
  });
}
