/* eslint-disable max-lines -- binary restore gating and swap flow stay together for readability */
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type { DevicePlanDevice } from './planTypes';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import type { PowerTrackerState } from '../core/powerTracker';
import {
  RESTORE_ADMISSION_FLOOR_KW,
} from './planConstants';
import { SwapState, SwapStateSnapshot, buildSwapState, cleanupStaleSwaps, exportSwapState } from './planSwapState';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from './planDebugDedupe';
import {
  buildSwapCandidates,
} from './planRestoreSwap';
import {
  buildInsufficientHeadroomUpdate,
  computeBaseRestoreNeed,
  resolveRestorePowerSource,
} from './planRestoreAccounting';
import {
  getInactiveReason,
  getOffDevices,
  getOnDevices,
  getSteppedRestoreCandidates,
  markOffDevicesStayOff,
} from './planRestoreDevices';
import {
  blockRestoreForRecentActivationSetback,
  isBlockedBySwapState,
  buildOffSteppedRestoreShedUpdate,
  markSteppedDevicesStayAtCurrentLevel,
  planRestoreForSteppedDevice,
  setRestorePlanDevice as setDevice,
  type SteppedRestoreSwapAttempt,
} from './planRestoreHelpers';
import { hasOtherDevicesWithUnconfirmedRecovery } from './planRestoreCoordination';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  buildRestoreTiming,
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
  shouldPlanRestores,
  type RestoreTiming,
} from './planRestoreTiming';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
} from './planRestoreAdmission';
import {
  getRestoreNeed,
  reserveHeadroomForPendingRestores,
} from './planRestoreSupport';
import { buildMeterSettlingReason, buildShortfallReason } from './planReasonStrings';
import { resolveEffectiveCurrentOn } from './planCurrentState';

export type RestoreDeps = {
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  };
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  deviceNameById?: ReadonlyMap<string, string>;
  logDebug: (...args: unknown[]) => void;
};

export type RestorePlanState = SwapStateSnapshot;

export type RestorePlanResult = {
  planDevices: DevicePlanDevice[];
  stateUpdates: RestorePlanState;
  restoredThisCycle: Set<string>;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs: number | null;
  shedCooldownTotalSec: number | null;
  restoreCooldownRemainingSec: number | null;
  restoreCooldownStartedAtMs: number | null;
  restoreCooldownTotalSec: number | null;
  inShedWindow: boolean;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};

/* eslint-disable-next-line max-lines-per-function, max-statements, complexity --
restore gating branches stay together at the top level. */
export function applyRestorePlan(params: {
  planDevices: DevicePlanDevice[];
  context: PlanContext;
  state: PlanEngineState;
  sheddingActive: boolean;
  guardInShortfall?: boolean;
  deps: RestoreDeps;
}): RestorePlanResult {
  const { planDevices, context, state, sheddingActive, guardInShortfall = false, deps } = params;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const swapState = buildSwapState(state);
  const timing = buildRestoreTiming(state, context.headroomRaw, deps.powerTracker);
  const capacityStartupStabilization = timing.inStartupStabilization && context.softLimitSource === 'capacity';
  const effectiveTiming = capacityStartupStabilization
    ? timing
    : {
      ...timing,
      inStartupStabilization: false as const,
      startupStabilizationRemainingSec: null,
      inShedWindow: timing.inCooldown || timing.activeOvershoot || timing.inRestoreCooldown,
    };
  cleanupStaleSwaps(swapState, deps.structuredLog);

  const restoredThisCycle = new Set<string>();
  let availableHeadroom = guardInShortfall
    ? context.headroomRaw
    : reserveHeadroomForPendingRestores({
      rawHeadroom: context.headroomRaw,
      planDevices,
      lastDeviceRestoreMs: state.lastDeviceRestoreMs,
      measurementTs: deps.powerTracker.lastTimestamp ?? null,
      debugStructured: deps.debugStructured,
      deviceNameById: deps.deviceNameById,
    });
  let restoredOneThisCycle = false;

  if (guardInShortfall) {
    markRestoreCandidatesStayShedForShortfall({
      deviceMap,
      headroomKw: context.headroomRaw,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    });
  } else if (shouldPlanRestores(context.headroomRaw, sheddingActive, effectiveTiming)) {
    const snapshot = Array.from(deviceMap.values());
    const offDevices = getOffDevices(snapshot);
    const onDevices = getOnDevices(snapshot, deps.getShedBehavior);
    for (const dev of offDevices) {
      const result = planRestoreForDevice({
        dev,
        deviceMap,
        onDevices,
        swapState,
        state,
        timing: effectiveTiming,
        availableHeadroom,
        restoredThisCycle,
        restoredOneThisCycle,
        deps,
      });
      availableHeadroom = result.availableHeadroom;
      restoredOneThisCycle = result.restoredOneThisCycle;
    }

    const steppedDevices = getSteppedRestoreCandidates(Array.from(deviceMap.values()));
    const steppedSwapAttempt = buildSteppedSwapAttempt({
      deviceMap,
      onDevices,
      swapState,
      state,
      timing: effectiveTiming,
      restoredThisCycle,
      deps,
    });
    for (const dev of steppedDevices) {
      const result = planRestoreForSteppedDevice({
        dev,
        deviceMap,
        state,
        timing: effectiveTiming,
        availableHeadroom,
        restoredOneThisCycle,
        debugStructured: deps.debugStructured,
        attemptSwapRestore: steppedSwapAttempt,
      });
      availableHeadroom = result.availableHeadroom;
      restoredOneThisCycle = result.restoredOneThisCycle;
    }
  } else if (
    sheddingActive
    || timing.inCooldown
    || effectiveTiming.inStartupStabilization
  ) {
    markOffDevicesStayOff({
      deviceMap,
      timing: effectiveTiming,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
    markSteppedDevicesStayAtCurrentLevel({
      deviceMap,
      timing: effectiveTiming,
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
  } else if (effectiveTiming.inRestoreCooldown) {
    const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
      timing: effectiveTiming,
      lastRestoreTs: state.lastRestoreMs,
    });
    if (meterSettlingRemainingSec !== null) {
      markOffDevicesMeterSettling({
        deviceMap,
        timing: effectiveTiming,
        lastRestoreTs: state.lastRestoreMs,
      });
    } else {
      markOffDevicesStayOff({
        deviceMap,
        timing: effectiveTiming,
        setDevice: (id, updates) => setDevice(deviceMap, id, updates),
        getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
      });
      markSteppedDevicesStayAtCurrentLevel({
        deviceMap,
        timing: effectiveTiming,
        getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
      });
    }
  }

  return {
    planDevices: Array.from(deviceMap.values()),
    stateUpdates: exportSwapState(swapState),
    restoredThisCycle,
    availableHeadroom,
    restoredOneThisCycle,
    ...effectiveTiming,
  };
}

function buildSteppedSwapAttempt(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: Pick<RestoreTiming, 'measurementTs'>;
  restoredThisCycle: Set<string>;
  deps: RestoreDeps;
}): SteppedRestoreSwapAttempt {
  const {
    deviceMap,
    onDevices,
    swapState,
    state,
    timing,
    restoredThisCycle,
    deps,
  } = params;
  return ({ dev, nextStep, lowestNonZeroStep, needed, availableHeadroom }) => {
    if (resolveEffectiveCurrentOn(dev) !== false) return null;
    if (!lowestNonZeroStep || nextStep.id !== lowestNonZeroStep.id) return null;

    const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
    return attemptSwapRestore({
      dev,
      deviceMap,
      onDevices,
      swapState,
      phase,
      availableHeadroom,
      restoreNeed: {
        needed,
        devPower: nextStep.planningPowerW / 1000,
        penaltyLevel: 0,
        penaltyExtraKw: 0,
      },
      measurementTs: timing.measurementTs,
      restoredThisCycle,
      deps,
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
      rejectedDeviceUpdate: buildRejectedSteppedSwapUpdate(dev),
    });
  };
}

function buildRejectedSteppedSwapUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  return buildOffSteppedRestoreShedUpdate(dev);
}

function buildRestoreShortfallReason(dev: DevicePlanDevice, headroomKw: number): DevicePlanDevice['reason'] {
  const { needed } = computeBaseRestoreNeed(dev);
  return buildShortfallReason(needed, headroomKw);
}

function markRestoreCandidatesStayShedForShortfall(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  headroomKw: number;
  setDevice: (id: string, updates: Partial<DevicePlanDevice>) => void;
}): void {
  const { deviceMap, headroomKw, setDevice: setPlanDevice } = params;
  markOffDevicesStayOff({
    deviceMap,
    timing: {
      activeOvershoot: false,
      inCooldown: false,
      inStartupStabilization: false,
      restoreCooldownSeconds: 0,
      shedCooldownRemainingSec: null,
      startupStabilizationRemainingSec: null,
    },
    setDevice: setPlanDevice,
    reasonOverride: (dev) => buildRestoreShortfallReason(dev, headroomKw),
  });

  const steppedCandidates = getSteppedRestoreCandidates([...deviceMap.values()]);
  for (const dev of steppedCandidates) {
    const currentOff = resolveEffectiveCurrentOn(dev) === false;
    const update: Partial<DevicePlanDevice> = {
      reason: buildRestoreShortfallReason(dev, headroomKw),
    };
    if (currentOff) update.plannedState = 'shed';
    if (!currentOff && dev.selectedStepId !== undefined) {
      update.plannedState = 'shed';
      update.desiredStepId = dev.selectedStepId;
      update.targetStepId = dev.selectedStepId;
      update.shedAction = 'set_step';
      update.shedStepId = dev.selectedStepId;
    }
    setPlanDevice(dev.id, update);
  }
}

/* eslint-disable-next-line max-lines-per-function, max-statements --
restore gating stays together to keep direct-vs-swap flow readable */
function planRestoreForDevice(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
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
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  deps: RestoreDeps;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    deviceMap,
    onDevices,
    swapState,
    state,
    timing,
    availableHeadroom,
    restoredThisCycle,
    restoredOneThisCycle,
    deps,
  } = params;

  const inactiveReason = getInactiveReason(dev);
  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  const restoreDebugKey = `binary:${dev.id}`;
  if (inactiveReason) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    setDevice(deviceMap, dev.id, {
      plannedState: 'inactive',
      reason: inactiveReason,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  const gateReason = resolveCapacityRestoreBlockReason({
    timing,
    restoredOneThisCycle,
  });
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing,
    lastRestoreTs: state.lastRestoreMs,
    restoredOneThisCycle,
  });
  if (meterSettlingRemainingSec !== null) {
    const reason = buildMeterSettlingReason(
      meterSettlingRemainingSec,
      resolveMeterSettlingCountdownTiming({
        timing,
        lastRestoreTs: state.lastRestoreMs,
        restoredOneThisCycle,
      }),
    );
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: formatDeviceReason(reason),
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: formatDeviceReason(reason),
      },
      signaturePayload: {
        event: 'restore_rejected',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: buildComparableDeviceReason(reason),
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: buildComparableDeviceReason(reason),
      },
      debugStructured: deps.debugStructured,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }
  if (gateReason) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: gateReason,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: formatDeviceReason(gateReason),
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: formatDeviceReason(gateReason),
      },
      signaturePayload: {
        event: 'restore_rejected',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: buildComparableDeviceReason(gateReason),
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: buildComparableDeviceReason(gateReason),
      },
      debugStructured: deps.debugStructured,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (isBlockedBySwapState(dev, deviceMap, swapState)) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const waitingReason = resolveCapacityRestoreBlockReason({
    timing,
    waitingForOtherRecovery: hasOtherDevicesWithUnconfirmedRecovery(deviceMap, dev.id),
  });
  if (waitingReason) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: waitingReason,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: formatDeviceReason(waitingReason),
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: formatDeviceReason(waitingReason),
      },
      signaturePayload: {
        event: 'restore_rejected',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        reason: buildComparableDeviceReason(waitingReason),
        availableKw: availableHeadroom,
        decision: 'rejected',
        decisionReason: buildComparableDeviceReason(waitingReason),
      },
      debugStructured: deps.debugStructured,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (blockRestoreForRecentActivationSetback({
    deviceMap,
    deviceId: dev.id,
    deviceName: dev.name,
    state,
    stepped: false,
    debugStructured: deps.debugStructured,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const restoreNeed = getRestoreNeed(dev, state, deps.deviceDiagnostics);
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: restoreNeed.needed });
  const powerSource = resolveRestorePowerSource(dev);
  if (admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) {
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_admitted',
        restoreType: 'binary',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        estimatedPowerKw: restoreNeed.devPower,
        powerSource,
        neededKw: restoreNeed.needed,
        availableKw: availableHeadroom,
        ...buildRestoreAdmissionLogFields(admission),
        minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
        decision: 'admitted',
        penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
        penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
      },
      debugStructured: deps.debugStructured,
    });
    restoredThisCycle.add(dev.id);
    return { availableHeadroom: availableHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
  }

  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_rejected',
      restoreType: 'binary',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      powerSource,
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      rejectionReason: 'insufficient_headroom',
      swapAttempt: true,
    },
    debugStructured: deps.debugStructured,
  });

  return attemptSwapRestore({
    dev,
    deviceMap,
    onDevices,
    swapState,
    phase,
    availableHeadroom,
    restoreNeed,
    measurementTs: timing.measurementTs,
    restoredThisCycle,
    deps,
  });
}

/* eslint-disable-next-line max-lines-per-function -- swap approval, logging, and state writes stay together */
function attemptSwapRestore(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  phase: 'startup' | 'runtime';
  availableHeadroom: number;
  restoreNeed: { needed: number; devPower: number; penaltyLevel: number; penaltyExtraKw: number };
  measurementTs: number | null;
  restoredThisCycle: Set<string>;
  deps: RestoreDeps;
  admittedDeviceUpdate?: Partial<DevicePlanDevice>;
  rejectedDeviceUpdate?: Partial<DevicePlanDevice>;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    deviceMap,
    onDevices,
    swapState,
    phase,
    availableHeadroom,
    restoreNeed,
    measurementTs,
    restoredThisCycle,
    deps,
    admittedDeviceUpdate,
    rejectedDeviceUpdate,
  } = params;

  if (measurementTs !== null && swapState.lastSwapPlanMeasurementTs.get(dev.id) === measurementTs) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: null },
    });
    return { availableHeadroom, restoredOneThisCycle: false };
  }

  if (swapState.pendingSwapTargets.has(dev.id)) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: null },
    });
    return { availableHeadroom, restoredOneThisCycle: false };
  }

  const swap = buildSwapCandidates({
    dev,
    onDevices,
    swappedOutFor: swapState.swappedOutFor,
    availableHeadroom,
    needed: restoreNeed.needed,
    restoredThisCycle,
  });
  if (!swap.ready) {
    setDevice(deviceMap, dev.id, buildRejectedSwapUpdate({
      availableHeadroom,
      restoreNeed,
      swap,
      rejectedDeviceUpdate,
    }));
    deps.debugStructured?.({
      event: 'restore_rejected',
      restoreType: 'swap',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      reason: formatDeviceReason(swap.reason),
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      effectiveAvailableKw: swap.effectiveHeadroom,
      ...buildRestoreAdmissionLogFields(swap.admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      swapReserveKw: swap.reserveKw,
      decision: 'rejected',
      rejectionReason: 'insufficient_headroom',
      decisionReason: formatDeviceReason(swap.reason),
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    });
    return { availableHeadroom, restoredOneThisCycle: false };
  }

  deps.debugStructured?.({
    event: 'restore_swap_approved',
    restoreType: 'swap',
    deviceId: dev.id,
    deviceName: dev.name,
    phase,
    shedDeviceIds: swap.toShed.map((d) => d.id),
    neededKw: restoreNeed.needed,
    potentialHeadroomKw: swap.potentialHeadroom,
    effectiveHeadroomKw: swap.effectiveHeadroom,
    ...buildRestoreAdmissionLogFields(swap.admission),
    swapReserveKw: swap.reserveKw,
    estimatedPowerKw: restoreNeed.devPower,
    powerSource: resolveRestorePowerSource(dev),
    decision: 'admitted',
    penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
    penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
  });
  swapState.pendingSwapTargets.add(dev.id);
  swapState.pendingSwapTimestamps.set(dev.id, Date.now());
  if (measurementTs !== null) {
    swapState.lastSwapPlanMeasurementTs.set(dev.id, measurementTs);
  }
  const nextHeadroom = swap.effectiveHeadroom;
  for (const shedDev of swap.toShed) {
    setDevice(deviceMap, shedDev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: dev.name },
    });
    deps.debugStructured?.({
      event: 'restore_swap_shed',
      shedDeviceId: shedDev.id,
      shedDeviceName: shedDev.name,
      forDeviceId: dev.id,
      forDeviceName: dev.name,
    });
    swapState.swappedOutFor.set(shedDev.id, dev.id);
  }
  restoredThisCycle.add(dev.id);
  setDevice(deviceMap, dev.id, { plannedState: 'keep', ...admittedDeviceUpdate });
  return { availableHeadroom: nextHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
}

function buildRejectedSwapUpdate(params: {
  availableHeadroom: number;
  restoreNeed: { needed: number; penaltyExtraKw: number };
  swap: ReturnType<typeof buildSwapCandidates>;
  rejectedDeviceUpdate?: Partial<DevicePlanDevice>;
}): Partial<DevicePlanDevice> {
  const { availableHeadroom, restoreNeed, swap, rejectedDeviceUpdate } = params;
  const directAdmission = buildRestoreAdmissionMetrics({
    availableKw: availableHeadroom,
    neededKw: restoreNeed.needed,
  });
  const shouldDescribeSwapReserve = swap.toShed.length > 0;
  return {
    ...buildInsufficientHeadroomUpdate({
      neededKw: restoreNeed.needed,
      availableKw: shouldDescribeSwapReserve ? swap.potentialHeadroom : availableHeadroom,
      postReserveMarginKw: shouldDescribeSwapReserve
        ? swap.admission.postReserveMarginKw
        : directAdmission.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      penaltyExtraKw: restoreNeed.penaltyExtraKw,
      swapReserveKw: shouldDescribeSwapReserve ? swap.reserveKw : undefined,
      effectiveAvailableKw: shouldDescribeSwapReserve ? swap.effectiveHeadroom : undefined,
    }),
    ...rejectedDeviceUpdate,
  };
}

function markOffDevicesMeterSettling(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: Pick<
    RestoreTiming,
    'activeOvershoot' | 'measurementTs' | 'nowTs'
  >;
  lastRestoreTs?: number | null;
}): void {
  const { deviceMap, timing, lastRestoreTs = null } = params;
  const remainingSec = resolveMeterSettlingRemainingSec({ timing, lastRestoreTs });
  if (remainingSec === null) return;
  const reason = buildMeterSettlingReason(
    remainingSec,
    resolveMeterSettlingCountdownTiming({ timing, lastRestoreTs }),
  );
  const snapshot: DevicePlanDevice[] = [];
  for (const dev of deviceMap.values()) snapshot.push(dev);

  const meterSettlingDevices = [
    ...getOffDevices(snapshot),
    ...getSteppedRestoreCandidates(snapshot).filter((dev) => resolveEffectiveCurrentOn(dev) === false),
  ];

  for (const dev of meterSettlingDevices) {
    const inactiveReason = getInactiveReason(dev);
    if (inactiveReason) {
      setDevice(deviceMap, dev.id, {
        plannedState: 'inactive',
        reason: inactiveReason,
      });
      continue;
    }

    const updates: Partial<DevicePlanDevice> = { plannedState: 'shed', reason };
    if (dev.steppedLoadProfile) {
      Object.assign(updates, buildRejectedSteppedSwapUpdate(dev));
    }
    setDevice(deviceMap, dev.id, updates);
  }
}
