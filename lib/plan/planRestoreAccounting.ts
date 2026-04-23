import type { DevicePlanDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import {
  PENDING_RESTORE_CONFIRMED_FRACTION,
  PENDING_RESTORE_WINDOW_MS,
} from './planConstants';
import { buildRestoreHeadroomReason } from './planReasonStrings';
import {
  resolveRestorePower as resolveSharedRestorePower,
  type RestorePowerSource as SharedRestorePowerSource,
} from './planPowerResolution';
import {
  resolveActiveSteppedRestoreReservation,
  resolveSteppedRestoreObservedGapKw,
} from './planSteppedRestorePending';

export function buildInsufficientHeadroomUpdate(params: {
  neededKw: number;
  availableKw: number;
  postReserveMarginKw: number;
  minimumRequiredPostReserveMarginKw: number;
  penaltyExtraKw?: number;
  swapReserveKw?: number;
  effectiveAvailableKw?: number;
  swapTargetName?: string;
}): Partial<DevicePlanDevice> {
  return {
    plannedState: 'shed',
    reason: buildRestoreHeadroomReason(params),
  };
}

export function computeRestoreBufferKw(devPower: number): number {
  const boundedPower = Math.max(0, devPower);
  const scaled = boundedPower * 0.1 + 0.1;
  return Math.max(0.2, Math.min(0.6, scaled));
}

export type RestorePowerSource = SharedRestorePowerSource;

export function resolveRestorePowerSource(dev: DevicePlanDevice): RestorePowerSource {
  return resolveSharedRestorePower(dev).source;
}

export function estimateRestorePower(dev: DevicePlanDevice): number {
  return resolveSharedRestorePower(dev).powerKw;
}

/**
 * Returns the total power (kW) to reserve for active restore attempts whose latent draw has not
 * yet shown up in observations. Stepped-load devices reserve from their active stepped restore
 * attempt, including off-path restores targeting the low step. Recent restore timestamps alone do
 * not create stepped reservation.
 */
export function computePendingRestorePowerKw(
  planDevices: DevicePlanDevice[],
  lastDeviceRestoreMs: Record<string, number>,
  nowTs: number,
  measurementTs: number | null = null,
): { pendingKw: number; deviceIds: string[] } {
  let pendingKw = 0;
  const deviceIds: string[] = [];
  for (const dev of planDevices) {
    const gap = resolvePendingRestoreGapKwForDevice(dev, lastDeviceRestoreMs, nowTs, measurementTs);
    if (gap > 0) {
      pendingKw += gap;
      deviceIds.push(dev.id);
    }
  }
  return { pendingKw, deviceIds };
}

function resolvePendingRestoreGapKwForDevice(
  dev: DevicePlanDevice,
  lastDeviceRestoreMs: Record<string, number>,
  nowTs: number,
  measurementTs: number | null,
): number {
  if (dev.plannedState === 'shed') return 0;

  const steppedReservation = resolveSteppedPendingReservationGapKw(dev, lastDeviceRestoreMs, nowTs, measurementTs);
  if (steppedReservation !== null) return steppedReservation;

  if (isSteppedLoadDevice(dev)) return 0;

  const restoreMs = lastDeviceRestoreMs[dev.id];
  if (!restoreMs || nowTs - restoreMs > PENDING_RESTORE_WINDOW_MS) return 0;
  if (!dev.currentOn) return 0;
  const expectedKw = estimateRestorePower(dev);
  const actualKw = Math.max(0, dev.measuredPowerKw ?? dev.powerKw ?? 0);
  if (actualKw >= expectedKw * PENDING_RESTORE_CONFIRMED_FRACTION) return 0;
  return expectedKw - actualKw;
}

function resolveSteppedPendingReservationGapKw(
  dev: DevicePlanDevice,
  lastDeviceRestoreMs: Record<string, number>,
  nowTs: number,
  measurementTs: number | null,
): number | null {
  if (!isSteppedLoadDevice(dev)) return null;
  const requestedStepId = dev.lastDesiredStepId ?? dev.desiredStepId;
  if (!requestedStepId) return null;
  const reservation = resolveActiveSteppedRestoreReservation(
    dev,
    requestedStepId,
    nowTs,
    {
      lastRestoreMs: lastDeviceRestoreMs[dev.id],
      measurementTs,
      powerSettleWindowMs: PENDING_RESTORE_WINDOW_MS,
    },
  );
  if (!reservation) return null;
  if (reservation.status === 'awaiting_power_settle') return reservation.deltaKw > 0 ? reservation.deltaKw : null;
  const gap = resolveSteppedRestoreObservedGapKw(dev, reservation);
  if (gap <= reservation.deltaKw * (1 - PENDING_RESTORE_CONFIRMED_FRACTION)) return null;
  return gap > 0 ? gap : null;
}

export function computeBaseRestoreNeed(
  dev: DevicePlanDevice,
): { power: number; buffer: number; needed: number } {
  const power = estimateRestorePower(dev);
  const buffer = computeRestoreBufferKw(power);
  return { power, buffer, needed: power + buffer };
}
