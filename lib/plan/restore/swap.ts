import { getLogger } from '../../logging/logger';
import type { DevicePlanDevice } from '../planTypes';
import { formatDeviceReason, PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import { RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import {
  buildRequestedTargetFromDeviceUpdate,
  buildSwapCandidates,
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
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { buildRestoreAdmissionLogFields, buildRestoreAdmissionMetrics } from '../admission';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import type { RestoreDeps } from './types';

const logger = getLogger('plan/restore');

export function attemptSwapRestore(params: {
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

  if (hasPendingSwapSourcesStillOn({ swapState, targetDeviceId: dev.id, deviceMap })) {
    setDevice(deviceMap, dev.id, buildSwapPendingTargetUpdate(dev));
    return { availableHeadroom, restoredOneThisCycle: false };
  }
  if (shouldKeepSwapTargetPending({ swapState, deviceId: dev.id, measurementTs })) {
    setDevice(deviceMap, dev.id, buildSwapPendingTargetUpdate(dev));
    return { availableHeadroom, restoredOneThisCycle: false };
  }
  if (shouldDeferSwapAdmissionForMeasurement({ swapState, deviceId: dev.id, measurementTs })) {
    return rejectSwapRestoreUntilFreshMeasurement({
      dev,
      deviceMap,
      availableHeadroom,
      restoreNeed,
      rejectedDeviceUpdate,
    });
  }
  if (measurementTs === null) {
    return rejectSwapRestoreWithoutMeasurement({
      dev,
      deviceMap,
      availableHeadroom,
      restoreNeed,
      rejectedDeviceUpdate,
    });
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
    return rejectSwapRestoreWithCandidates({
      dev,
      deviceMap,
      phase,
      availableHeadroom,
      restoreNeed,
      swap,
      rejectedDeviceUpdate,
      deps,
    });
  }

  emitSwapApprovedDebug({ dev, phase, restoreNeed, swap, deps });
  markApprovedSwapTarget({ swapState, dev, measurementTs, admittedDeviceUpdate });
  for (const shedDev of swap.toShed) {
    setDevice(deviceMap, shedDev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: dev.name },
    });
    if (deps.debugStructured) {

      deps.debugStructured({
      event: 'restore_swap_shed',
      shedDeviceId: shedDev.id,
      shedDeviceName: shedDev.name,
      forDeviceId: dev.id,
      forDeviceName: dev.name,
    });

    } else {

      logger.debug({
      event: 'restore_swap_shed',
      shedDeviceId: shedDev.id,
      shedDeviceName: shedDev.name,
      forDeviceId: dev.id,
      forDeviceName: dev.name,
    });

    }
    markDeviceSwappedOutFor(swapState, shedDev.id, dev.id);
  }
  setDevice(deviceMap, dev.id, buildSwapPendingTargetUpdate(dev));
  return { availableHeadroom, restoredOneThisCycle: false };
}

function hasPendingSwapSourcesStillOn(params: {
  swapState: SwapState;
  targetDeviceId: string;
  deviceMap: ReadonlyMap<string, DevicePlanDevice>;
}): boolean {
  const { swapState, targetDeviceId, deviceMap } = params;
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

export function holdPendingSwapTargetUntilSourcesAreOff(params: {
  swapState: SwapState;
  targetDevice: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
}): boolean {
  const { swapState, targetDevice, deviceMap } = params;
  if (!hasPendingSwapSourcesStillOn({ swapState, targetDeviceId: targetDevice.id, deviceMap })) return false;
  setDevice(deviceMap, targetDevice.id, buildSwapPendingTargetUpdate(targetDevice));
  return true;
}

function markApprovedSwapTarget(params: {
  swapState: SwapState;
  dev: DevicePlanDevice;
  measurementTs: number;
  admittedDeviceUpdate?: Partial<DevicePlanDevice>;
}): void {
  const { swapState, dev, measurementTs, admittedDeviceUpdate } = params;
  markSwapTargetPending(swapState, dev.id);
  recordSwapPlanMeasurement(swapState, dev.id, measurementTs);
  recordRequestedTarget(
    swapState,
    dev.id,
    buildRequestedTargetFromDeviceUpdate(admittedDeviceUpdate),
  );
}

function rejectSwapRestoreWithCandidates(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  phase: 'startup' | 'runtime';
  availableHeadroom: number;
  restoreNeed: { needed: number; devPower: number; penaltyLevel: number; penaltyExtraKw: number };
  swap: ReturnType<typeof buildSwapCandidates>;
  rejectedDeviceUpdate?: Partial<DevicePlanDevice>;
  deps: RestoreDeps;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, phase, availableHeadroom, restoreNeed, swap, rejectedDeviceUpdate, deps } = params;
  setDevice(deviceMap, dev.id, buildRejectedSwapUpdate({
    availableHeadroom,
    restoreNeed,
    swap,
    rejectedDeviceUpdate,
  }));
  if (deps.debugStructured) {

    deps.debugStructured({
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

  } else {

    logger.debug({
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

  }
  return { availableHeadroom, restoredOneThisCycle: false };
}

function emitSwapApprovedDebug(params: {
  dev: DevicePlanDevice;
  phase: 'startup' | 'runtime';
  restoreNeed: { needed: number; devPower: number; penaltyLevel: number; penaltyExtraKw: number };
  swap: ReturnType<typeof buildSwapCandidates>;
  deps: RestoreDeps;
}): void {
  const { dev, phase, restoreNeed, swap, deps } = params;
  if (deps.debugStructured) {

    deps.debugStructured({
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

  } else {

    logger.debug({
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
}

function rejectSwapRestoreWithoutMeasurement(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  availableHeadroom: number;
  restoreNeed: { needed: number; penaltyExtraKw: number };
  rejectedDeviceUpdate?: Partial<DevicePlanDevice>;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, availableHeadroom, restoreNeed, rejectedDeviceUpdate } = params;
  setDevice(deviceMap, dev.id, buildRejectedSwapUpdate({
    availableHeadroom,
    restoreNeed,
    rejectedDeviceUpdate,
  }));
  return { availableHeadroom, restoredOneThisCycle: false };
}

function rejectSwapRestoreUntilFreshMeasurement(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  availableHeadroom: number;
  restoreNeed: { needed: number; penaltyExtraKw: number };
  rejectedDeviceUpdate?: Partial<DevicePlanDevice>;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  return rejectSwapRestoreWithoutMeasurement(params);
}

function buildSwapPendingTargetUpdate(dev: DevicePlanDevice): Partial<DevicePlanDevice> {
  const reason = { code: PLAN_REASON_CODES.swapPending, targetName: null } as const;
  if (isSteppedLoadDevice(dev) && !isOffSteppedRestoreCandidate(dev)) {
    return { plannedState: 'keep', reason };
  }
  return { plannedState: 'shed', reason };
}

function buildRejectedSwapUpdate(params: {
  availableHeadroom: number;
  restoreNeed: { needed: number; penaltyExtraKw: number };
  swap?: ReturnType<typeof buildSwapCandidates>;
  rejectedDeviceUpdate?: Partial<DevicePlanDevice>;
}): Partial<DevicePlanDevice> {
  const { availableHeadroom, restoreNeed, swap, rejectedDeviceUpdate } = params;
  const directAdmission = buildRestoreAdmissionMetrics({
    availableKw: availableHeadroom,
    neededKw: restoreNeed.needed,
  });
  const shouldDescribeSwapReserve = (swap?.toShed.length ?? 0) > 0;
  return {
    ...buildInsufficientHeadroomUpdate({
      neededKw: restoreNeed.needed,
      availableKw: shouldDescribeSwapReserve ? swap?.potentialHeadroom ?? availableHeadroom : availableHeadroom,
      postReserveMarginKw: shouldDescribeSwapReserve
        ? swap?.admission.postReserveMarginKw ?? directAdmission.postReserveMarginKw
        : directAdmission.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      penaltyExtraKw: restoreNeed.penaltyExtraKw,
      swapReserveKw: shouldDescribeSwapReserve ? swap?.reserveKw : undefined,
      effectiveAvailableKw: shouldDescribeSwapReserve ? swap?.effectiveHeadroom : undefined,
    }),
    ...rejectedDeviceUpdate,
  };
}
