import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import { RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { isBlockedBySwapState, type SwapState } from '../swap';
import { buildInsufficientHeadroomUpdate, resolveRestorePowerSource } from './accounting';
import { getInactiveReason } from './devices';
import { blockRestoreForRecentActivationSetback, setRestorePlanDevice as setDevice } from './helpers';
import { hasOtherDevicesWithUnconfirmedRecovery } from './coordination';
import {
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
} from './timing';
import {
  buildReservedForStartReason,
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveReserveAdmission,
  resolveRestoreDecisionPhase,
  type HeadroomReserve,
} from '../admission';
import { getRestoreNeed } from './support';
import { buildMeterSettlingReason } from '../planReasonStrings';
import { attemptSwapRestore } from './swap';
import {
  canAttemptBatchContinuation,
  recordBatchAdmission,
} from './batch';
import type {
  RestoreAdmissionMode,
  RestoreBatchState,
  RestoreDeps,
  RestoreDeviceTiming,
} from './types';
import {
  applyBinaryCooldownPreviewAdmission,
  shouldApplyInCycleRestoreGate,
  shouldRejectBatchContinuation,
} from './cooldownPreview';

/* eslint-disable-next-line max-lines-per-function, max-statements --
restore gating stays together to keep direct-vs-swap flow readable */
export function planRestoreForDevice(params: {
  dev: DevicePlanDevice; deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[]; swapState: SwapState; state: PlanEngineState;
  timing: RestoreDeviceTiming;
  availableHeadroom: number;
  restoredThisCycle: Set<string>; restoredOneThisCycle: boolean;
  batchState: RestoreBatchState; deps: RestoreDeps;
  headroomReserves: readonly HeadroomReserve[];
  admissionMode?: RestoreAdmissionMode;
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
    batchState,
    deps,
    headroomReserves,
    admissionMode = { kind: 'apply' },
  } = params;

  const inactiveReason = getInactiveReason(dev);
  const phase = resolveRestoreDecisionPhase(state.currentRebuildTrigger);
  const restoreDebugKey = `binary:${dev.id}`;
  if (inactiveReason) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    setDevice(deviceMap, dev.id, {
      plannedState: 'inactive',
      reason: inactiveReason,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  const batchContinuation = restoredOneThisCycle && canAttemptBatchContinuation(batchState);
  const shouldBlockForInCycleRestore = shouldApplyInCycleRestoreGate(
    admissionMode, restoredOneThisCycle, batchContinuation,
  );
  const gateReason = resolveCapacityRestoreBlockReason({
    timing,
    restoredOneThisCycle: shouldBlockForInCycleRestore,
  });
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing,
    lastRestoreTs: state.lastRestoreMs,
    restoredOneThisCycle: shouldBlockForInCycleRestore,
  });
  if (meterSettlingRemainingSec !== null) {
    return rejectBinaryRestoreForMeterSettling({
      state,
      deviceMap,
      dev,
      phase,
      timing,
      lastRestoreTs: state.lastRestoreMs,
      restoredOneThisCycle: shouldBlockForInCycleRestore,
      availableHeadroom,
      restoreDebugKey,
      restoredOneThisCycleResult: restoredOneThisCycle,
      debugStructured: deps.debugStructured,
    });
  }
  if (gateReason) {
    return rejectBinaryRestore({
      state,
      deviceMap,
      dev,
      phase,
      reason: gateReason,
      availableHeadroom,
      restoreDebugKey,
      restoredOneThisCycle,
      debugStructured: deps.debugStructured,
    });
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
    return rejectBinaryRestore({
      state,
      deviceMap,
      dev,
      phase,
      reason: waitingReason,
      availableHeadroom,
      restoreDebugKey,
      restoredOneThisCycle,
      debugStructured: deps.debugStructured,
    });
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
  if (shouldRejectBatchContinuation(
    admissionMode, batchContinuation, batchState, restoreNeed.needed,
  )) {
    return rejectBinaryRestoreForMeterSettling({
      state,
      deviceMap,
      dev,
      phase,
      timing,
      lastRestoreTs: state.lastRestoreMs,
      restoredOneThisCycle: true,
      availableHeadroom,
      restoreDebugKey,
      restoredOneThisCycleResult: restoredOneThisCycle,
      debugStructured: deps.debugStructured,
    });
  }
  // Admit against the power this device may actually claim: raw available power minus any startup
  // reservation held by a strictly higher-priority device that has not started yet. The running
  // `availableHeadroom` total is still decremented by the raw need on admission — the reserve
  // shapes who may take the power, not how much taking it costs.
  const reserved = resolveReserveAdmission({
    dev, availableHeadroom, neededKw: restoreNeed.needed, reserves: headroomReserves,
  });
  const { admission, effectiveHeadroomKw } = reserved;
  const powerSource = resolveRestorePowerSource(dev);
  if (reserved.kind === 'admitted') {
    const previewResult = applyBinaryCooldownPreviewAdmission({
      admissionMode, dev, deviceMap, availableHeadroom, neededKw: restoreNeed.needed,
      restoredOneThisCycle, batchContinuation, batchState,
    });
    if (previewResult) return previewResult;
    const penaltyFields = restoreNeed.penaltyLevel > 0
      ? { penaltyLevel: restoreNeed.penaltyLevel, penaltyExtraKw: restoreNeed.penaltyExtraKw }
      : {};
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
        availableKw: effectiveHeadroomKw,
        ...buildRestoreAdmissionLogFields(admission),
        minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
        decision: 'admitted',
        ...penaltyFields,
      },
      debugStructured: deps.debugStructured,
    });
    restoredThisCycle.add(dev.id);
    recordBatchAdmission(batchState, restoreNeed.needed);
    return { availableHeadroom: availableHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
  }

  // The reservation is the ONLY thing standing in the way: there is enough raw power, it is just
  // spoken for. Say so on the card, and stop here rather than falling through to the swap path —
  // pausing a running device to take a block that is already promised to someone else would
  // defeat the reservation.
  if (reserved.kind === 'blocked_by_reserve') {
    return rejectBinaryRestore({
      state,
      deviceMap,
      dev,
      phase,
      reason: buildReservedForStartReason(reserved.holderName),
      availableHeadroom,
      restoreDebugKey,
      restoredOneThisCycle,
      debugStructured: deps.debugStructured,
    });
  }

  return handleInsufficientBinaryRestoreHeadroom({
    state,
    dev,
    deviceMap,
    onDevices,
    swapState,
    phase,
    powerSource,
    availableHeadroom,
    reservedHeadroomKw: reserved.reservedKw,
    restoreNeed,
    admission,
    measurementTs: timing.measurementTs,
    restoredThisCycle,
    restoredOneThisCycle,
    batchContinuation,
    restoreDebugKey,
    deps,
    allowSwap: admissionMode.kind === 'apply',
  });
}

// Collapses the two near-identical gate/waiting reject branches: both mark the device shed with
// the supplied reason and emit the identical restore_rejected debug payload (event + signature),
// differing only in which reason produced the block.
function rejectBinaryRestore(params: {
  state: PlanEngineState; deviceMap: Map<string, DevicePlanDevice>; dev: DevicePlanDevice;
  phase: ReturnType<typeof resolveRestoreDecisionPhase>;
  reason: DevicePlanDevice['reason'];
  availableHeadroom: number; restoreDebugKey: string; restoredOneThisCycle: boolean;
  debugStructured: RestoreDeps['debugStructured'];
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    state,
    deviceMap,
    dev,
    phase,
    reason,
    availableHeadroom,
    restoreDebugKey,
    restoredOneThisCycle,
    debugStructured,
  } = params;
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
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason: reason.code,
    },
    debugStructured,
  });
  return { availableHeadroom, restoredOneThisCycle };
}

function rejectBinaryRestoreForMeterSettling(params: {
  state: PlanEngineState; deviceMap: Map<string, DevicePlanDevice>; dev: DevicePlanDevice;
  phase: ReturnType<typeof resolveRestoreDecisionPhase>;
  timing: Parameters<typeof resolveMeterSettlingRemainingSec>[0]['timing'];
  lastRestoreTs?: number | null;
  restoredOneThisCycle: boolean;
  availableHeadroom: number;
  restoreDebugKey: string;
  restoredOneThisCycleResult: boolean;
  debugStructured: RestoreDeps['debugStructured'];
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    state,
    deviceMap,
    dev,
    phase,
    timing,
    lastRestoreTs,
    restoredOneThisCycle,
    availableHeadroom,
    restoreDebugKey,
    restoredOneThisCycleResult,
    debugStructured,
  } = params;
  const remainingSec = resolveMeterSettlingRemainingSec({ timing, lastRestoreTs, restoredOneThisCycle }) ?? 0;
  const reason = buildMeterSettlingReason(
    remainingSec,
    resolveMeterSettlingCountdownTiming({ timing, lastRestoreTs, restoredOneThisCycle }),
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
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason: reason.code,
    },
    debugStructured,
  });
  return { availableHeadroom, restoredOneThisCycle: restoredOneThisCycleResult };
}

function rejectBinaryRestoreForInsufficientHeadroom(params: {
  state: PlanEngineState;
  deviceMap: Map<string, DevicePlanDevice>;
  dev: DevicePlanDevice;
  phase: ReturnType<typeof resolveRestoreDecisionPhase>;
  powerSource: ReturnType<typeof resolveRestorePowerSource>;
  restoreNeed: ReturnType<typeof getRestoreNeed>;
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>;
  availableHeadroom: number;
  restoreDebugKey: string;
  restoredOneThisCycle: boolean;
  debugStructured: RestoreDeps['debugStructured'];
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    state,
    deviceMap,
    dev,
    phase,
    powerSource,
    restoreNeed,
    admission,
    availableHeadroom,
    restoreDebugKey,
    restoredOneThisCycle,
    debugStructured,
  } = params;
  setDevice(deviceMap, dev.id, buildInsufficientHeadroomUpdate({
    neededKw: restoreNeed.needed,
    availableKw: availableHeadroom,
    postReserveMarginKw: admission.postReserveMarginKw,
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
    penaltyExtraKw: restoreNeed.penaltyExtraKw,
  }));
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
    },
    debugStructured,
  });
  return { availableHeadroom, restoredOneThisCycle };
}

function handleInsufficientBinaryRestoreHeadroom(params: {
  state: PlanEngineState;
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  phase: ReturnType<typeof resolveRestoreDecisionPhase>;
  powerSource: ReturnType<typeof resolveRestorePowerSource>;
  availableHeadroom: number;
  // Power a higher-priority device has reserved for its own start. Withheld from the swap
  // decision as well as from direct admission: shedding a running device to take a block that is
  // already promised would defeat the reservation AND issue the very write it exists to avoid.
  reservedHeadroomKw: number;
  restoreNeed: ReturnType<typeof getRestoreNeed>;
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>;
  measurementTs: number | null;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  batchContinuation: boolean;
  restoreDebugKey: string;
  deps: RestoreDeps;
  allowSwap: boolean;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    state,
    dev,
    deviceMap,
    onDevices,
    swapState,
    phase,
    powerSource,
    availableHeadroom,
    reservedHeadroomKw,
    restoreNeed,
    admission,
    measurementTs,
    restoredThisCycle,
    restoredOneThisCycle,
    batchContinuation,
    restoreDebugKey,
    deps,
    allowSwap,
  } = params;
  const rejectDirectly = (): { availableHeadroom: number; restoredOneThisCycle: boolean } => (
    rejectBinaryRestoreForInsufficientHeadroom({
      state,
      deviceMap,
      dev,
      phase,
      powerSource,
      restoreNeed,
      admission,
      availableHeadroom,
      restoreDebugKey,
      restoredOneThisCycle,
      debugStructured: deps.debugStructured,
    })
  );
  if (batchContinuation || !allowSwap) return rejectDirectly();

  // No rejection is announced before the swap runs. It used to be: this branch
  // emitted `restore_rejected` and then attempted the swap, so a device that the
  // swap went on to admit was logged as rejected first, and a device it did not
  // was logged as rejected twice. A restore decision is made once, by whichever
  // path owns it.
  //
  // The swap decides against the RESERVED figure, so a swap can only proceed by freeing enough to
  // cover this device's need on top of the block already promised elsewhere. `attemptSwapRestore`
  // returns the headroom it was handed unchanged on every path, so the caller's running total is
  // restored here rather than leaking the reservation into it.
  const swap = attemptSwapRestore({
    dev,
    deviceMap,
    onDevices,
    swapState,
    state,
    restoreDebugKey,
    phase,
    availableHeadroom: availableHeadroom - reservedHeadroomKw,
    restoreNeed,
    measurementTs,
    restoredThisCycle,
    deps,
  });
  // Nothing was running to swap out, so no swap happened and the direct
  // shortfall is the whole story — the same figures this device's card carries.
  if (swap.kind === 'no_source') return rejectDirectly();
  return {
    availableHeadroom: swap.availableHeadroom + reservedHeadroomKw,
    restoredOneThisCycle: swap.restoredOneThisCycle,
  };
}
