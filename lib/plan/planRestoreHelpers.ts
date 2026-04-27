/* eslint-disable max-lines -- Restore helper decisions and their countdown metadata are kept together. */
import type { DevicePlanDevice } from './planTypes';
import type { RestoreTiming } from './planRestoreTiming';
import type { SwapState } from './planSwapState';
import type { PlanEngineState } from './planState';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import {
  getSteppedRestoreCandidates,
  NEUTRAL_STARTUP_HOLD_REASON,
} from './planRestoreDevices';
import {
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
} from './planRestoreTiming';
import {
  getSteppedLoadNextRestoreStep,
  resolveSteppedLoadRestoreDeltaKw,
} from './planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import {
  getActivationPenaltyLevel,
  getActivationRestoreBlockCountdownTiming,
  getActivationRestoreBlockRemainingMs,
} from './planActivationBackoff';
import { computeRestoreBufferKw } from './planRestoreAccounting';
import { RESTORE_ADMISSION_FLOOR_KW } from './planConstants';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from './planDebugDedupe';
import {
  countShedDevices,
  hasOtherDevicesBlockingSteppedRestore,
} from './planRestoreCoordination';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
  type RestoreAdmissionMetrics,
} from './planRestoreAdmission';
import {
  buildActivationBackoffReason,
  buildMeterSettlingReason,
  buildRestoreHeadroomReason,
} from './planReasonStrings';
import { applySteppedRestoreAttemptHold } from './planSteppedRestoreHold';

export function setRestorePlanDevice(
  deviceMap: Map<string, DevicePlanDevice>,
  id: string,
  updates: Partial<DevicePlanDevice>,
): void {
  const current = deviceMap.get(id);
  if (!current) return;
  deviceMap.set(id, { ...current, ...updates });
}

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
    const currentOff = resolveEffectiveCurrentOn(dev) === false;
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

/**
 * Returns true if this device should be held back from restoring because a swap is still
 * in progress. Checks both whether this device was explicitly swapped out for a specific
 * higher-priority target (`swappedOutFor`), and whether any other higher-priority target
 * in `pendingSwapTargets` is still off. Also cleans up stale swap state.
 */
export function isBlockedBySwapState(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
): boolean {
  if (isBlockedByDirectSwap(dev, deviceMap, swapState)) return true;
  return isBlockedByPendingSwapTarget(dev, deviceMap, swapState);
}

function isBlockedByDirectSwap(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
): boolean {
  const swappedFor = swapState.swappedOutFor.get(dev.id);
  if (!swappedFor) return false;
  const higherPriDev = deviceMap.get(swappedFor);
  if (higherPriDev && higherPriDev.currentState === 'off') {
    setRestorePlanDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: higherPriDev.name },
    });
    return true;
  }
  swapState.swappedOutFor.delete(dev.id);
  swapState.pendingSwapTargets.delete(swappedFor);
  swapState.pendingSwapTimestamps.delete(swappedFor);
  return false;
}

function isBlockedByPendingSwapTarget(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
): boolean {
  if (swapState.pendingSwapTargets.size === 0 || swapState.pendingSwapTargets.has(dev.id)) return false;
  const devPriority = dev.priority ?? 100;
  for (const swapTargetId of swapState.pendingSwapTargets) {
    if (swapTargetId === dev.id) continue;
    const swapTargetDev = deviceMap.get(swapTargetId);
    if (!swapTargetDev) {
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
      continue;
    }
    const swapTargetPriority = swapTargetDev.priority ?? 100;
    if (swapTargetPriority <= devPriority && swapTargetDev.currentState === 'off') {
      setRestorePlanDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: { code: PLAN_REASON_CODES.swapPending, targetName: swapTargetDev.name },
      });
      return true;
    }
    if (swapTargetDev.currentState === 'on') {
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
    }
  }
  return false;
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

/* eslint-disable-next-line max-statements -- stepped restore gating mirrors binary restore precedence */
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
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, timing, availableHeadroom, restoredOneThisCycle, debugStructured } = params;
  const restoreDebugKey = `stepped:${dev.id}`;

  if (countShedDevices(deviceMap, dev.id) === 0) {
    delete state.steppedRestoreRejectedByDevice[dev.id];
  }

  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing,
    lastRestoreTs: state.lastRestoreMs,
    restoredOneThisCycle,
  });
  if (meterSettlingRemainingSec !== null) {
    setRestorePlanDevice(deviceMap, dev.id, {
      reason: buildMeterSettlingReason(
        meterSettlingRemainingSec,
        resolveMeterSettlingCountdownTiming({
          timing,
          lastRestoreTs: state.lastRestoreMs,
          restoredOneThisCycle,
        }),
      ),
    });
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }
  const gateReason = resolveCapacityRestoreBlockReason({ timing, restoredOneThisCycle });
  if (gateReason) {
    setRestorePlanDevice(deviceMap, dev.id, { reason: gateReason });
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const waitingReason = resolveCapacityRestoreBlockReason({
    timing,
    waitingForOtherRecovery: hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.lastDeviceShedMs),
  });
  if (waitingReason) {
    setRestorePlanDevice(deviceMap, dev.id, { reason: waitingReason });
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (blockRestoreForRecentActivationSetback({
    deviceMap, deviceId: dev.id, deviceName: dev.name, state, stepped: true, debugStructured,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const nextStep = getSteppedLoadNextRestoreStep(dev);
  if (!nextStep) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const lowestNonZeroStep = dev.steppedLoadProfile
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
  });
}

function admitSteppedRestore(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  phase: 'startup' | 'runtime';
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
  deltaKw: number;
  availableHeadroom: number;
  debugStructured?: StructuredDebugEmitter;
  restoreDebugKey: string;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, phase, nextStep, lowestNonZeroStep,
    deltaKw, availableHeadroom, debugStructured, restoreDebugKey } = params;
  const restoreBuffer = computeRestoreBufferKw(deltaKw);
  const needed = deltaKw + restoreBuffer;
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: needed });
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (admission.postReserveMarginKw < RESTORE_ADMISSION_FLOOR_KW) {
    return rejectSteppedRestoreForInsufficientHeadroom({
      dev, deviceMap, state, phase, nextStep, lowestNonZeroStep, shedDeviceCount,
      admission, availableHeadroom, needed, debugStructured, restoreDebugKey,
    });
  }
  setRestorePlanDevice(deviceMap, dev.id, {
    desiredStepId: nextStep.id,
    expectedPowerKw: nextStep.planningPowerW / 1000,
    reason: {
      code: PLAN_REASON_CODES.restoreNeed,
      fromTarget: dev.selectedStepId ?? 'unknown',
      toTarget: nextStep.id,
      needKw: needed,
      headroomKw: null,
    },
  });
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_admitted',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId ?? 'unknown',
      toStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep?.id,
      blockedByShedInvariant: false,
      shedDeviceCount,
      deltaKw,
      neededKw: needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'admitted',
    },
    debugStructured,
  });
  return { availableHeadroom: availableHeadroom - needed, restoredOneThisCycle: true };
}

function blockSteppedRestoreForShedInvariant(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
  phase: 'startup' | 'runtime';
  debugStructured?: StructuredDebugEmitter;
  restoreDebugKey: string;
}): boolean {
  const { dev, deviceMap, state, nextStep, lowestNonZeroStep, phase, debugStructured, restoreDebugKey } = params;
  if (!lowestNonZeroStep || nextStep.planningPowerW <= lowestNonZeroStep.planningPowerW) return false;
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (shedDeviceCount === 0) return false;
  const reason = {
    code: PLAN_REASON_CODES.shedInvariant,
    fromStep: dev.selectedStepId ?? 'unknown',
    toStep: nextStep.id,
    shedDeviceCount,
    maxStep: lowestNonZeroStep.id,
  } as const;
  setRestorePlanDevice(deviceMap, dev.id, { reason });

  const prev = state.steppedRestoreRejectedByDevice[dev.id];
  const unchanged = prev !== undefined
    && prev.requestedStepId === nextStep.id
    && prev.lowestNonZeroStepId === lowestNonZeroStep.id
    && prev.shedDeviceCount === shedDeviceCount;
  if (!unchanged) {
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_stepped_rejected',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId ?? 'unknown',
        requestedStepId: nextStep.id,
        lowestNonZeroStepId: lowestNonZeroStep.id,
        allowedMaxStepId: lowestNonZeroStep.id,
        blockedByShedInvariant: true,
        shedDeviceCount,
        decision: 'rejected',
        rejectionReason: 'shed_invariant',
        reason: formatDeviceReason(reason),
      },
      signaturePayload: {
        event: 'restore_stepped_rejected',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId ?? 'unknown',
        requestedStepId: nextStep.id,
        lowestNonZeroStepId: lowestNonZeroStep.id,
        allowedMaxStepId: lowestNonZeroStep.id,
        blockedByShedInvariant: true,
        shedDeviceCount,
        decision: 'rejected',
        rejectionReason: 'shed_invariant',
        reason: buildComparableDeviceReason(reason),
      },
      debugStructured,
    });
    state.steppedRestoreRejectedByDevice[dev.id] = {
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      shedDeviceCount,
    };
  }
  return true;
}

function rejectSteppedRestoreForInsufficientHeadroom(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  phase: 'startup' | 'runtime';
  nextStep: { id: string };
  lowestNonZeroStep: { id: string } | null;
  shedDeviceCount: number;
  admission: RestoreAdmissionMetrics;
  availableHeadroom: number;
  needed: number;
  debugStructured?: StructuredDebugEmitter;
  restoreDebugKey: string;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, phase, nextStep, lowestNonZeroStep, shedDeviceCount,
    admission, availableHeadroom, needed, debugStructured, restoreDebugKey } = params;
  const update: Partial<DevicePlanDevice> = {
    reason: buildRestoreHeadroomReason({
      neededKw: needed,
      availableKw: availableHeadroom,
      postReserveMarginKw: admission.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
    }),
  };
  if (resolveEffectiveCurrentOn(dev) === false) {
    const offStepId = dev.steppedLoadProfile
      ? (getSteppedLoadOffStep(dev.steppedLoadProfile) ?? getSteppedLoadLowestStep(dev.steppedLoadProfile))?.id
      : dev.selectedStepId;
    update.plannedState = 'shed';
    update.desiredStepId = offStepId;
    update.targetStepId = offStepId;
    update.shedAction = dev.shedAction ?? (dev.hasBinaryControl === false ? 'set_step' : 'turn_off');
  }
  setRestorePlanDevice(deviceMap, dev.id, update);
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId ?? 'unknown',
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep?.id,
      blockedByShedInvariant: false,
      shedDeviceCount,
      neededKw: needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      rejectionReason: 'insufficient_headroom',
    },
    debugStructured,
  });
  return { availableHeadroom, restoredOneThisCycle: false };
}
