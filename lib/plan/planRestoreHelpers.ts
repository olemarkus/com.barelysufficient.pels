/* eslint-disable max-lines -- Restore helper decisions and their countdown metadata are kept together. */
import type { DevicePlanDevice } from './planTypes';
import type { RestoreTiming } from './planRestoreTiming';
import type { PlanEngineState } from './planState';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { isObservedOff, isObservedOn } from '../observer/observedState';
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

export type SteppedSwapExecutor = (params: {
  dev: DevicePlanDevice;
  needed: number;
  devPower: number;
  availableHeadroom: number;
  admittedDeviceUpdate: Partial<DevicePlanDevice>;
  rejectedDeviceUpdate: Partial<DevicePlanDevice>;
}) => { availableHeadroom: number; restoredOneThisCycle: boolean };

export function setRestorePlanDevice(
  deviceMap: Map<string, DevicePlanDevice>,
  id: string,
  updates: Partial<DevicePlanDevice>,
): void {
  const current = deviceMap.get(id);
  if (!current) return;
  deviceMap.set(id, { ...current, ...updates });
}

export function buildOffSteppedRestoreShedUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  const offStepId = dev.steppedLoadProfile
    ? (getSteppedLoadOffStep(dev.steppedLoadProfile) ?? getSteppedLoadLowestStep(dev.steppedLoadProfile))?.id
    : dev.selectedStepId;
  return {
    plannedState: 'shed',
    desiredStepId: offStepId,
    targetStepId: offStepId,
    shedAction: dev.shedAction ?? (dev.hasBinaryControl === false ? 'set_step' : 'turn_off'),
  };
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
    const currentOff = isObservedOff(dev);
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

type SteppedDeviceGateTiming = Pick<RestoreTiming,
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
function applySteppedDeviceGates(params: {
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
    && hasOtherDevicesBlockingSteppedRestore(deviceMap, dev.id, state.lastDeviceShedMs);
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
  // restore cooldown or meter-settling gate — per-device restore timing still applies.
  const deviceIsActive = isObservedOn(dev);
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
    swapExecutor,
  });
}

function buildOffSteppedRestoreHoldUpdate(
  dev: DevicePlanDevice,
  reason: DevicePlanDevice['reason'],
): Partial<DevicePlanDevice> {
  return {
    ...buildOffSteppedRestoreShedUpdate(dev),
    reason,
  };
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
  swapExecutor?: SteppedSwapExecutor;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, phase, nextStep, lowestNonZeroStep,
    deltaKw, availableHeadroom, debugStructured, restoreDebugKey, swapExecutor } = params;
  const restoreBuffer = computeRestoreBufferKw(deltaKw);
  const needed = deltaKw + restoreBuffer;
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: needed });
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (admission.postReserveMarginKw < RESTORE_ADMISSION_FLOOR_KW) {
    if (swapExecutor
        && canUseSwapForSteppedRestore({ dev, nextStep, lowestNonZeroStep })) {
      return swapExecutor({
        dev,
        needed,
        devPower: nextStep.planningPowerW / 1000,
        availableHeadroom,
        admittedDeviceUpdate: {
          desiredStepId: nextStep.id,
          targetStepId: nextStep.id,
          expectedPowerKw: nextStep.planningPowerW / 1000,
          reason: {
            code: PLAN_REASON_CODES.restoreNeed,
            fromTarget: dev.selectedStepId ?? 'unknown',
            toTarget: nextStep.id,
            needKw: needed,
            headroomKw: null,
          },
        },
        rejectedDeviceUpdate: resolveRejectedSteppedSwapUpdate(dev),
      });
    }
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

function resolveRejectedSteppedSwapUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  return isObservedOff(dev)
    ? buildOffSteppedRestoreShedUpdate(dev)
    : { plannedState: 'keep' };
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
  if (isBoostEffectiveForEscalation(dev)) return false;
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

function canUseSwapForSteppedRestore(params: {
  dev: DevicePlanDevice;
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
}): boolean {
  const { dev, nextStep, lowestNonZeroStep } = params;
  if (lowestNonZeroStep === null) return false;
  if (isObservedOff(dev) && nextStep.id === lowestNonZeroStep.id) return true;
  return isBoostEffectiveForEscalation(dev);
}

/**
 * True when a boost is active *and* there is no evidence that the device is
 * idle at its current step. Calibration-confident `false` for
 * `hasRecentObservedDrawAtSelectedStep` blocks the boost-driven bypass —
 * boost should not escalate a device past its current step when the device
 * has not been accepting load there (e.g. a Hoiax holding at its element
 * setpoint, or a thermostat in a room already at target). When the
 * calibration store has no opinion (undefined), the bypass behaves as
 * before so newly-paired devices are not penalized during warm-up.
 */
function isBoostEffectiveForEscalation(dev: DevicePlanDevice): boolean {
  const boostActive = dev.temperatureBoostActive === true || dev.evBoostActive === true;
  if (!boostActive) return false;
  if (dev.hasRecentObservedDrawAtSelectedStep === false) return false;
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
  const reason = buildRestoreHeadroomReason({
    neededKw: needed,
    availableKw: availableHeadroom,
    postReserveMarginKw: admission.postReserveMarginKw,
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
  });
  const update: Partial<DevicePlanDevice> = isObservedOff(dev)
    ? { ...buildOffSteppedRestoreShedUpdate(dev), reason }
    : { reason };
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
