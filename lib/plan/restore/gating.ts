import { spendPowerHeadroom } from '../powerLimitMath';
import type { DevicePlanDevice, MeteredDevicePlanDevice } from '../planTypes';
import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { buildInsufficientHeadroomUpdate, resolveRestorePowerSource } from './accounting';
import { resolveInactiveRestoreUpdate } from './devices';
import { blockRestoreForRecentActivationSetback, setRestorePlanDevice as setDevice } from './helpers';
import {
  shouldWaitForOtherRecovery,
} from './coordination';
import {
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingReason,
} from './timing';
import {
  buildReserveAdmittedLogFields,
  buildReservedForStartReason,
  isReserveAdmitted,
  resolveReserveAdmission,
  type ReserveInsufficient,
} from '../admission';
import { getRestoreNeed } from './support';
import { buildMeterSettlingReason } from '../planReasonStrings';
import { attemptSwapRestore } from './swap';
import {
  canAdmitWithinBatch,
  canAttemptBatchContinuation,
  recordBatchAdmission,
} from './batch';
import type {
  RestoreCycle,
  RestoreLane,
  RestoreLoopState,
} from './types';

/* eslint-disable-next-line max-statements --
restore gating stays together to keep direct-vs-swap flow readable */
export function planRestoreForDevice(
  cycle: RestoreCycle,
  lane: RestoreLane,
  dev: MeteredDevicePlanDevice,
  loop: RestoreLoopState,
): RestoreLoopState {
  const {
    state, deviceMap, swapLedger, timing, restoredThisCycle,
    batchState, deps, headroomReserves, phase,
  } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;

  const inactiveUpdate = resolveInactiveRestoreUpdate(dev);
  const restoreDebugKey = `binary:${dev.id}`;
  if (inactiveUpdate) {
    clearRestoreDebugEvent(state, restoreDebugKey);
    setDevice(deviceMap, dev.id, inactiveUpdate);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const batchContinuation = restoredOneThisCycle && canAttemptBatchContinuation(batchState);
  // One restore per cycle, unless the batch is still open for this one to join.
  const shouldBlockForInCycleRestore = restoredOneThisCycle && !batchContinuation;
  const gateReason = resolveCapacityRestoreBlockReason({
    timing,
    restoredOneThisCycle: shouldBlockForInCycleRestore,
  });
  const meterSettlingReason = resolveMeterSettlingReason(
    timing, state.actuation.lastRestoreMs, shouldBlockForInCycleRestore,
  );
  if (meterSettlingReason !== null) {
    return rejectBinaryRestore(cycle, dev, loop, meterSettlingReason);
  }
  if (gateReason) {
    return rejectBinaryRestore(cycle, dev, loop, gateReason);
  }

  const blockingTarget = swapLedger.blockingTarget(dev, deviceMap);
  if (blockingTarget !== undefined) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: blockingTarget.name },
    });
    clearRestoreDebugEvent(state, restoreDebugKey);
    return { availableHeadroom, restoredOneThisCycle };
  }

  const waitingReason = resolveCapacityRestoreBlockReason({
    timing,
    waitingForOtherRecovery: shouldWaitForOtherRecovery(deviceMap, dev.id, batchContinuation),
  });
  if (waitingReason) {
    return rejectBinaryRestore(cycle, dev, loop, waitingReason);
  }

  if (blockRestoreForRecentActivationSetback({
    deviceMap,
    deviceId: dev.id,
    deviceName: dev.name,
    state,
    nowTs: timing.nowTs,
    stepped: false,
  })) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const restoreNeed = getRestoreNeed(dev, state, timing.nowTs, deps.deviceDiagnostics);
  if (batchContinuation && !canAdmitWithinBatch(batchState, restoreNeed.needed)) {
    return rejectBinaryRestore(cycle, dev, loop, resolveBatchFullReason(cycle));
  }
  // Admit against the power this device may actually claim: raw available power minus any startup
  // reservation held by a strictly higher-priority device that has not started yet. The running
  // `availableHeadroom` total is still decremented by the raw need on admission — the reserve
  // shapes who may take the power, not how much taking it costs.
  const reserved = resolveReserveAdmission({
    dev, availableHeadroom, neededKw: restoreNeed.needed, reserves: headroomReserves,
  });
  const powerSource = resolveRestorePowerSource(dev);
  if (isReserveAdmitted(reserved)) {
    const penaltyFields = restoreNeed.penaltyLevel > 0
      ? { penaltyLevel: restoreNeed.penaltyLevel, penaltyExtraKw: restoreNeed.penaltyExtraKw }
      : {};
    const admittedLog = buildReserveAdmittedLogFields(reserved);
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
        availableKw: admittedLog.effectiveHeadroomKw,
        marginKw: admittedLog.marginKw,
        decision: 'admitted',
        ...penaltyFields,
      },
    });
    restoredThisCycle.add(dev.id);
    recordBatchAdmission(batchState, restoreNeed.needed);
    return { availableHeadroom: spendPowerHeadroom(availableHeadroom, restoreNeed.needed), restoredOneThisCycle: true };
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

// Every gate that holds a binary restore (meter settling, the capacity gate, waiting on other
// devices, a startup reservation) marks the device shed with its reason and emits the identical
// restore_rejected debug payload (event + signature), differing only in which reason held it.
function rejectBinaryRestore(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
  reason: DevicePlanDevice['reason'],
): RestoreLoopState {
  const { state, deviceMap, phase } = cycle;
  const { availableHeadroom } = loop;
  const restoreDebugKey = `binary:${dev.id}`;
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
  });
  return loop;
}

/**
 * The hold a restore carries when the open batch has no room left for it: the
 * meter-settling window this cycle's admissions opened.
 */
function resolveBatchFullReason(cycle: RestoreCycle): DevicePlanDevice['reason'] {
  return resolveMeterSettlingReason(cycle.timing, cycle.state.actuation.lastRestoreMs, true)
    ?? buildMeterSettlingReason(null);
}

function rejectBinaryRestoreForInsufficientHeadroom(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  loop: RestoreLoopState,
  restoreNeed: ReturnType<typeof getRestoreNeed>,
  reserved: ReserveInsufficient,
): RestoreLoopState {
  const { state, deviceMap, phase } = cycle;
  const { admission, availableKw: availableHeadroom } = reserved;
  const powerSource = resolveRestorePowerSource(dev);
  const restoreDebugKey = `binary:${dev.id}`;
  setDevice(deviceMap, dev.id, buildInsufficientHeadroomUpdate({
    neededKw: restoreNeed.needed,
    availableKw: availableHeadroom,
    marginKw: admission.marginKw,
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
      marginKw: admission.marginKw,
      decision: 'rejected',
      rejectionReason: 'insufficient_headroom',
    },
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
  reserved: ReserveInsufficient,
): RestoreLoopState {
  const { batchState } = cycle;
  const { onDevices } = lane;
  const { restoredOneThisCycle } = loop;
  const { availableKw, reservedKw: reservedHeadroomKw } = reserved;
  const restoreDebugKey = `binary:${dev.id}`;
  const batchContinuation = restoredOneThisCycle && canAttemptBatchContinuation(batchState);
  const rejectDirectly = (): RestoreLoopState => (
    rejectBinaryRestoreForInsufficientHeadroom(cycle, dev, loop, restoreNeed, reserved)
  );
  if (batchContinuation) return rejectDirectly();

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
    availableKw - reservedHeadroomKw,
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
