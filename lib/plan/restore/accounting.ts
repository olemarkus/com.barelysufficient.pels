import type { DevicePlanDevice } from '../planTypes';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { getSteppedLoadRestoreStep } from '../../utils/deviceControlProfiles';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import {
  PENDING_RESTORE_CONFIRMED_FRACTION,
  PENDING_RESTORE_WINDOW_MS,
  RECENT_SHED_EXTRA_BUFFER_KW,
  RECENT_SHED_RESTORE_BACKOFF_MS,
  RECENT_SHED_RESTORE_MULTIPLIER,
} from '../planConstants';
import { buildRestoreHeadroomReason } from '../planReasonStrings';
import { getRestoreDrawKw } from '../../observer/observedPower';
import {
  resolveActiveSteppedRestoreReservation,
  resolveSteppedRestoreObservedGapKw,
} from '../planSteppedRestorePending';
import type { RestorePowerSource } from '../../../packages/contracts/src/types';

// Re-exported for plan-layer consumers (planReasons, restore/index, tests)
// that read `RestorePowerSource` from this module. The canonical declaration
// lives in `packages/contracts/src/types.ts`.
export type { RestorePowerSource };

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

export function resolveRestorePowerSource(dev: DevicePlanDevice): RestorePowerSource {
  return resolveRestorePower(dev).source;
}

export function estimateRestorePower(dev: DevicePlanDevice): number {
  return resolveRestorePower(dev).kw;
}

function resolveRestorePower(
  dev: DevicePlanDevice,
): { kw: number; source: RestorePowerSource } {
  // Producer-resolved path (chunk 4 of the planner-detype refactor). When the
  // device snapshot carries `residualKw.restore`, the
  // `isSteppedLoadDevice + getSteppedLoadRestoreStep` chain has already been
  // collapsed at the producer seam (`lib/device/deviceResidualKw.ts`), so the
  // consumer just reads the resolved `{ kw, source }`. The legacy fallback
  // below covers fixtures built without the producer-resolved field; chunk 6
  // removes it.
  if (dev.residualKw?.restore) return dev.residualKw.restore;
  const stepped = resolveSteppedRestorePower(dev);
  if (stepped !== null) return stepped;
  return getRestoreDrawKw(dev);
}

function resolveSteppedRestorePower(
  dev: DevicePlanDevice,
): { kw: number; source: RestorePowerSource } | null {
  if (!isSteppedLoadDevice(dev)) return null;

  if (dev.currentState !== 'off' && isFiniteNumber(dev.planningPowerKw) && dev.planningPowerKw > 0) {
    return { kw: dev.planningPowerKw, source: 'planning' };
  }

  const restoreStep = getSteppedLoadRestoreStep(dev.steppedLoadProfile);
  if (restoreStep && restoreStep.planningPowerW > 0) {
    return { kw: restoreStep.planningPowerW / 1000, source: 'stepped' };
  }

  return null;
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
  // This branch is non-stepped (stepped exits earlier). The producer-resolved
  // `currentOn` is authoritative for binary-only devices, and matches the rest of
  // the binary pending-restore-gap math below. A non-binary device (no control
  // capability this cycle) is never "observed off" here — same as the prior
  // absent-field default.
  if (isBinaryPlanDevice(dev) && dev.currentOn === false) return 0;
  const expectedKw = estimateRestorePower(dev);
  const actualKw = dev.currentDrawKw;
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

/**
 * The recent-shed inflation the restore gate applies on top of the base need: a
 * device shed within `RECENT_SHED_RESTORE_BACKOFF_MS` must clear a deliberately
 * higher bar before PELS puts it back, so the same marginal power does not flap
 * it straight off again.
 *
 * Pure, and shared on purpose. `getRestoreNeed` (`restore/support.ts`) gates the
 * restore lane on this figure, and `resolveCeilingShortfall`
 * (`planReasonShortfall.ts`) states the card's gap against it — measuring the
 * two against different needs is how the card came to claim a device would be
 * admitted while the gate had just rejected it on a larger number.
 */
export function applyRecentShedInflation(params: {
  baseNeededKw: number;
  lastDeviceShedMs: number | undefined;
  nowMs: number;
}): number {
  const { baseNeededKw, lastDeviceShedMs, nowMs } = params;
  // The clock is injected (two callers, two stages of the same cycle), so the
  // window is bounded at BOTH ends: a `nowMs` before the shed stamp is not
  // "recently shed", it is a nonsense elapsed time, and inflating on it would
  // silently raise the restore bar.
  const elapsedMs = lastDeviceShedMs === undefined ? null : nowMs - lastDeviceShedMs;
  const recentlyShed = lastDeviceShedMs !== undefined
    && lastDeviceShedMs > 0
    && elapsedMs !== null
    && elapsedMs >= 0
    && elapsedMs < RECENT_SHED_RESTORE_BACKOFF_MS;
  if (!recentlyShed) return baseNeededKw;
  return Math.max(
    baseNeededKw * RECENT_SHED_RESTORE_MULTIPLIER,
    baseNeededKw + RECENT_SHED_EXTRA_BUFFER_KW,
  );
}
