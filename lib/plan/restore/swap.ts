import { getLogger } from '../../logging/logger';
import type { DevicePlanDevice } from '../planTypes';
import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import { RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import {
  buildRequestedTargetFromDeviceUpdate,
  buildSwapCandidates,
  hasSwappableDraw,
  markDeviceSwappedOutFor,
  markSwapTargetPending,
  recordRequestedTarget,
  recordSwapPlanMeasurement,
  shouldDeferSwapAdmissionForMeasurement,
  shouldKeepSwapTargetPending,
  type SwapState,
} from '../swap';
import { buildInsufficientHeadroomUpdate, resolveRestorePowerSource } from './accounting';
import { isOffSteppedRestoreCandidate } from './devices';
import { setRestorePlanDevice as setDevice } from './helpers';
import type { RestoreNeed } from './support';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { buildRestoreAdmissionLogFields, buildRestoreAdmissionMetrics } from '../admission';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { clearRestoreDebugEvent, emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import type { RestoreCycle, RestoreDeps } from './types';

/**
 * What a swap attempt did with the device.
 *
 * `decided` — the swap owns this device's outcome: it was approved, held
 * mid-handshake while its sources turn off, or rejected with the swap's own
 * reason and log line. The caller passes the result straight through.
 *
 * `no_source` — nothing was running that this cycle could pause, so no swap
 * was attempted and nothing was written. The caller's own rejection is the
 * decision, and it is the honest one: with no source to shed, the device is
 * short by the direct-admission figures its card already shows, not by the
 * swap arithmetic.
 */
export type SwapRestoreOutcome =
  | { kind: 'decided'; availableHeadroom: number; restoredOneThisCycle: boolean }
  | { kind: 'no_source' };

const logger = getLogger('plan/restore');

/**
 * What to merge onto the device on each swap outcome. Both are always present:
 * an empty partial means "nothing extra to merge", which is a value, not an
 * absent one — the stepped lane supplies rung fields, the binary lane does not.
 */
export type SwapDeviceUpdates = {
  admitted: Partial<DevicePlanDevice>;
  rejected: Partial<DevicePlanDevice>;
};

export function attemptSwapRestore(
  cycle: RestoreCycle,
  /** Only the on-devices half of the lane: taking the whole lane would make the
   *  stepped-swap executor depend on a lane that contains itself. */
  onDevices: DevicePlanDevice[],
  dev: DevicePlanDevice,
  availableHeadroom: number,
  restoreNeed: RestoreNeed,
  /** The caller's per-device restore-decision key. Shared on purpose: a device
   *  has one restore decision per cycle, so direct and swap rejections dedupe
   *  against each other and a move between them re-emits. */
  restoreDebugKey: string,
  updates: SwapDeviceUpdates,
): SwapRestoreOutcome {
  const { deviceMap, swapState, state, restoredThisCycle, deps } = cycle;
  const measurementTs = cycle.timing.measurementTs;
  const { admitted: admittedDeviceUpdate, rejected: rejectedDeviceUpdate } = updates;

  if (hasPendingSwapSourcesStillOn(swapState, dev.id, deviceMap)) {
    setDevice(deviceMap, dev.id, buildSwapPendingTargetUpdate(dev));
    return { kind: 'decided', availableHeadroom, restoredOneThisCycle: false };
  }
  if (shouldKeepSwapTargetPending({ swapState, deviceId: dev.id, measurementTs })) {
    setDevice(deviceMap, dev.id, buildSwapPendingTargetUpdate(dev));
    return { kind: 'decided', availableHeadroom, restoredOneThisCycle: false };
  }
  // Both measurement stand-downs name their own cause. They used to log nothing
  // at all and be covered by the caller's pre-announcement, which labelled them
  // `insufficient_headroom` — but the shortfall is not why the swap stood down,
  // and once the pre-announcement went they would have gone silent entirely.
  if (shouldDeferSwapAdmissionForMeasurement({ swapState, deviceId: dev.id, measurementTs })) {
    return rejectSwapRestoreForMeasurement(
      cycle, dev, availableHeadroom, restoreNeed, restoreDebugKey,
      rejectedDeviceUpdate, 'awaiting_fresh_measurement',
    );
  }
  if (measurementTs === null) {
    return rejectSwapRestoreForMeasurement(
      cycle, dev, availableHeadroom, restoreNeed, restoreDebugKey,
      rejectedDeviceUpdate, 'no_measurement',
    );
  }

  // Nothing is running that this cycle could pause, so the search below would
  // walk every on-device and come back with an empty `toShed` — for this
  // candidate and, since the test is candidate-independent, for every other one
  // in the pass. Hand the decision back rather than re-deriving a rejection the
  // caller has already computed. The handshake gates above run first on
  // purpose: a device mid-swap is held by them even after its sources have
  // stopped drawing, which is exactly when this test goes false.
  if (!hasSwappableDraw(onDevices, swapState.swappedOutFor, restoredThisCycle)) {
    return { kind: 'no_source' };
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
    return rejectSwapRestoreWithCandidates(
      cycle, dev, availableHeadroom, restoreNeed, swap, restoreDebugKey, rejectedDeviceUpdate,
    );
  }

  // An approval retires whatever rejection the key was holding, so a swap that
  // is later undone re-announces the block instead of being deduped against the
  // decision it replaced.
  clearRestoreDebugEvent(state, restoreDebugKey);
  emitSwapApprovedDebug(cycle, dev, restoreNeed, swap);
  markApprovedSwapTarget(swapState, dev, measurementTs, admittedDeviceUpdate);
  for (const shedDev of swap.toShed) {
    setDevice(deviceMap, shedDev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: dev.name },
    });
    emitSwapDebug(deps, {
      event: 'restore_swap_shed',
      shedDeviceId: shedDev.id,
      shedDeviceName: shedDev.name,
      forDeviceId: dev.id,
      forDeviceName: dev.name,
    });
    markDeviceSwappedOutFor(swapState, shedDev.id, dev.id);
  }
  setDevice(deviceMap, dev.id, buildSwapPendingTargetUpdate(dev));
  return { kind: 'decided', availableHeadroom, restoredOneThisCycle: false };
}

function hasPendingSwapSourcesStillOn(
  swapState: SwapState,
  targetDeviceId: string,
  deviceMap: ReadonlyMap<string, DevicePlanDevice>,
): boolean {
  for (const [deviceId, swappedOutFor] of swapState.swappedOutFor) {
    if (swappedOutFor !== targetDeviceId) continue;
    const sourceDevice = deviceMap.get(deviceId);
    if (!sourceDevice) return true;
    // A swap source can be any kind: a binary device is off via `!currentOn`, a
    // step-only stepper via the step axis. Partition rather than assume binary —
    // a binary-only check would treat an off step-only source as "still on" and
    // hold its swap target indefinitely.
    const sourceOff = isBinaryPlanDevice(sourceDevice)
      ? !sourceDevice.currentOn
      : isOffSteppedRestoreCandidate(sourceDevice);
    if (!sourceOff) return true;
  }
  return false;
}

export function holdPendingSwapTargetUntilSourcesAreOff(
  swapState: SwapState,
  targetDevice: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
): boolean {
  if (!hasPendingSwapSourcesStillOn(swapState, targetDevice.id, deviceMap)) return false;
  setDevice(deviceMap, targetDevice.id, buildSwapPendingTargetUpdate(targetDevice));
  return true;
}

function markApprovedSwapTarget(
  swapState: SwapState,
  dev: DevicePlanDevice,
  measurementTs: number,
  admittedDeviceUpdate: Partial<DevicePlanDevice>,
): void {
  markSwapTargetPending(swapState, dev.id);
  recordSwapPlanMeasurement(swapState, dev.id, measurementTs);
  recordRequestedTarget(
    swapState,
    dev.id,
    buildRequestedTargetFromDeviceUpdate(admittedDeviceUpdate),
  );
}

function rejectSwapRestoreWithCandidates(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  availableHeadroom: number,
  restoreNeed: RestoreNeed,
  swap: ReturnType<typeof buildSwapCandidates>,
  restoreDebugKey: string,
  rejectedDeviceUpdate: Partial<DevicePlanDevice>,
): SwapRestoreOutcome {
  const { deviceMap, state, deps, phase } = cycle;
  setDevice(deviceMap, dev.id, buildRejectedSwapUpdate(
    availableHeadroom, restoreNeed, rejectedDeviceUpdate, swap,
  ));
  // Change-gated like every other restore decision. This was the one emitter
  // that wrote unconditionally, so a house pinned under its budget re-announced
  // the same rejection for every shed device on every rebuild: 39.8k of these
  // lines, 36.8 MB, in a single production log.
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_rejected',
      restoreType: 'swap',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
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
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    },
    debugStructured: deps.debugStructured,
  });
  return { kind: 'decided', availableHeadroom, restoredOneThisCycle: false };
}

function emitSwapApprovedDebug(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  restoreNeed: RestoreNeed,
  swap: ReturnType<typeof buildSwapCandidates>,
): void {
  const { deps, phase } = cycle;
  emitSwapDebug(deps, {
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
}

// A swap approval and the sheds that fund it are events, not a standing state,
// so they emit every time rather than through the decision gate.
function emitSwapDebug(deps: RestoreDeps, payload: Record<string, unknown>): void {
  if (deps.debugStructured) {
    deps.debugStructured(payload);
    return;
  }
  logger.debug(payload);
}

/**
 * The swap stood down over the meter, not over power: either no reading exists
 * yet (`no_measurement`, a cold start) or this device already planned a swap
 * against the reading in hand and must wait for a fresher one
 * (`awaiting_fresh_measurement`). No candidate search runs, so the card carries
 * the direct shortfall and the log carries the real cause.
 */
function rejectSwapRestoreForMeasurement(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  availableHeadroom: number,
  restoreNeed: RestoreNeed,
  restoreDebugKey: string,
  rejectedDeviceUpdate: Partial<DevicePlanDevice>,
  rejectionReason: 'no_measurement' | 'awaiting_fresh_measurement',
): SwapRestoreOutcome {
  const { deviceMap, state, deps, phase } = cycle;
  setDevice(deviceMap, dev.id, buildRejectedSwapUpdate(
    availableHeadroom, restoreNeed, rejectedDeviceUpdate, null,
  ));
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_rejected',
      restoreType: 'swap',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
    },
    debugStructured: deps.debugStructured,
  });
  return { kind: 'decided', availableHeadroom, restoredOneThisCycle: false };
}

function buildSwapPendingTargetUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  const reason = { code: PLAN_REASON_CODES.swapPending, targetName: null } as const;
  if (isSteppedLoadDevice(dev) && !isOffSteppedRestoreCandidate(dev)) {
    return { plannedState: 'keep', reason };
  }
  return { plannedState: 'shed', reason };
}

/**
 * `swap` is null on the paths that reject before candidates are ever built (the
 * two measurement stand-downs). That is a genuine domain absence — there is no
 * swap to describe — not a missing input.
 */
function buildRejectedSwapUpdate(
  availableHeadroom: number,
  restoreNeed: RestoreNeed,
  rejectedDeviceUpdate: Partial<DevicePlanDevice>,
  swap: ReturnType<typeof buildSwapCandidates> | null,
): Partial<DevicePlanDevice> {
  const directAdmission = buildRestoreAdmissionMetrics({
    availableKw: availableHeadroom,
    neededKw: restoreNeed.needed,
  });
  const shouldDescribeSwapReserve = swap !== null && swap.toShed.length > 0;
  return {
    ...buildInsufficientHeadroomUpdate({
      neededKw: restoreNeed.needed,
      availableKw: shouldDescribeSwapReserve ? swap?.potentialHeadroom ?? availableHeadroom : availableHeadroom,
      // Display margin from the UNCLAMPED swap headroom (see buildSwapCandidates):
      // the clamped admission margin flattens the shortfall in deep over-pace.
      postReserveMarginKw: shouldDescribeSwapReserve
        ? swap?.displayPostReserveMarginKw ?? directAdmission.postReserveMarginKw
        : directAdmission.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      penaltyExtraKw: restoreNeed.penaltyExtraKw,
      swapReserveKw: shouldDescribeSwapReserve ? swap?.reserveKw : undefined,
      effectiveAvailableKw: shouldDescribeSwapReserve ? swap?.displayEffectiveHeadroomKw : undefined,
    }),
    ...rejectedDeviceUpdate,
  };
}
