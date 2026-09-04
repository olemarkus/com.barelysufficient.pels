import type { DevicePlanDevice } from '../planTypes';
import { RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { isBlockedBySwapState } from '../swap';
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
} from '../admission';
import { getRestoreNeed } from './support';
import { buildMeterSettlingReason } from '../planReasonStrings';
import { attemptSwapRestore } from './swap';
import {
  canAttemptBatchContinuation,
  recordBatchAdmission,
} from './batch';
import type {
  RestoreCycle,
  RestoreLane,
  RestoreLoopState,
} from './types';
import {
  applyBinaryCooldownPreviewAdmission,
  shouldApplyInCycleRestoreGate,
  shouldRejectBatchContinuation,
} from './cooldownPreview';

/* eslint-disable-next-line max-statements --
restore gating stays together to keep direct-vs-swap flow readable */
export function planRestoreForDevice(
  cycle: RestoreCycle,
  lane: RestoreLane,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
): RestoreLoopState {
  const {
    state, deviceMap, swapState, timing, restoredThisCycle,
    batchState, deps, headroomReserves, admissionMode, phase,
  } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;

  const inactiveReason = getInactiveReason(dev);
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
    return rejectBinaryRestoreForMeterSettling(cycle, dev, loop, shouldBlockForInCycleRestore);
  }
  if (gateReason) {
    return rejectBinaryRestore(cycle, dev, loop, gateReason);
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
    return rejectBinaryRestore(cycle, dev, loop, waitingReason);
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
    return rejectBinaryRestoreForMeterSettling(cycle, dev, loop, true);
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
    return rejectBinaryRestore(cycle, dev, loop, buildReservedForStartReason(reserved.holderName));
  }

  return handleInsufficientBinaryRestoreHeadroom(cycle, lane, dev, loop, restoreNeed, reserved);
}

// Collapses the two near-identical gate/waiting reject branches: both mark the device shed with
// the supplied reason and emit the identical restore_rejected debug payload (event + signature),
// differing only in which reason produced the block.
function rejectBinaryRestore(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
  reason: DevicePlanDevice['reason'],
): RestoreLoopState {
  const { state, deviceMap, deps, phase } = cycle;
  const { availableHeadroom } = loop;
  const restoreDebugKey = `binary:${dev.id}`;
  const debugStructured = deps.debugStructured;
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
  return loop;
}

/**
 * `gateRestoredOne` is the value the settling countdown is computed against
 * (the in-cycle gate's verdict); the value this returns is the caller's own
 * running `loop.restoredOneThisCycle`. They differ on purpose, which is why the
 * bag carried two near-identically named booleans.
 */
function rejectBinaryRestoreForMeterSettling(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
  gateRestoredOne: boolean,
): RestoreLoopState {
  const { state, deviceMap, deps, timing, phase } = cycle;
  const { availableHeadroom } = loop;
  const lastRestoreTs = state.lastRestoreMs;
  const restoredOneThisCycle = gateRestoredOne;
  const restoreDebugKey = `binary:${dev.id}`;
  const debugStructured = deps.debugStructured;
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
  return loop;
}

function rejectBinaryRestoreForInsufficientHeadroom(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
  restoreNeed: ReturnType<typeof getRestoreNeed>,
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>,
): RestoreLoopState {
  const { state, deviceMap, deps, phase } = cycle;
  const { availableHeadroom } = loop;
  const powerSource = resolveRestorePowerSource(dev);
  const restoreDebugKey = `binary:${dev.id}`;
  const debugStructured = deps.debugStructured;
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
  return loop;
}

/**
 * `reserved` arrives whole rather than exploded: the reserved kW and the
 * admission metrics are two faces of the one `resolveReserveAdmission` result,
 * and the swap decides against the reserved figure while the caller's running
 * total is restored from the raw one.
 */
function handleInsufficientBinaryRestoreHeadroom(
  cycle: RestoreCycle,
  lane: RestoreLane,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
  restoreNeed: ReturnType<typeof getRestoreNeed>,
  reserved: ReturnType<typeof resolveReserveAdmission>,
): RestoreLoopState {
  const { batchState, admissionMode } = cycle;
  const { onDevices } = lane;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  const { admission, reservedKw: reservedHeadroomKw } = reserved;
  const restoreDebugKey = `binary:${dev.id}`;
  const allowSwap = admissionMode.kind === 'apply';
  const batchContinuation = restoredOneThisCycle && canAttemptBatchContinuation(batchState);
  const rejectDirectly = (): RestoreLoopState => (
    rejectBinaryRestoreForInsufficientHeadroom(cycle, dev, loop, restoreNeed, admission)
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
  const swap = attemptSwapRestore(
    cycle,
    onDevices,
    dev,
    availableHeadroom - reservedHeadroomKw,
    restoreNeed,
    restoreDebugKey,
    { admitted: {}, rejected: {} },
  );
  // Nothing was running to swap out, so no swap happened and the direct
  // shortfall is the whole story — the same figures this device's card carries.
  if (swap.kind === 'no_source') return rejectDirectly();
  return {
    availableHeadroom: swap.availableHeadroom + reservedHeadroomKw,
    restoredOneThisCycle: swap.restoredOneThisCycle,
  };
}
