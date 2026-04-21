import type { DevicePlanDevice } from './planTypes';
import { resolveCandidatePower } from './planCandidatePower';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import {
  PENDING_RESTORE_CONFIRMED_FRACTION,
  PENDING_RESTORE_WINDOW_MS,
  RESTORE_ADMISSION_FLOOR_KW,
  SWAP_RESTORE_RESERVE_KW,
} from './planConstants';
import { buildRestoreAdmissionMetrics, type RestoreAdmissionMetrics } from './planRestoreAdmission';
import { buildRestoreHeadroomReason } from './planReasonStrings';
import {
  formatDeviceReason,
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  resolveRestorePower as resolveSharedRestorePower,
  type RestorePowerSource as SharedRestorePowerSource,
} from './planPowerResolution';

function isViableSwapCandidate(
  onDev: DevicePlanDevice,
  dev: DevicePlanDevice,
  swappedOutFor: ReadonlyMap<string, string>,
  restoredThisCycle: ReadonlySet<string>,
): boolean {
  const onDevPriority = onDev.priority ?? 100;
  const devPriority = dev.priority ?? 100;
  if (onDevPriority <= devPriority) return false;
  if (onDev.plannedState === 'shed') return false;
  if (swappedOutFor.has(onDev.id)) return false;
  if (restoredThisCycle.has(onDev.id)) return false;
  return true;
}

export function buildSwapCandidates(params: {
  dev: DevicePlanDevice;
  onDevices: DevicePlanDevice[];
  swappedOutFor: ReadonlyMap<string, string>;
  availableHeadroom: number;
  needed: number;
  restoredThisCycle: ReadonlySet<string>;
}): {
  ready: boolean;
  toShed: DevicePlanDevice[];
  shedNames: string;
  shedPower: string;
  potentialHeadroom: number;
  effectiveHeadroom: number;
  admission: RestoreAdmissionMetrics;
  reserveKw: number;
  reason: DeviceReason;
} {
  const {
    dev,
    onDevices,
    swappedOutFor,
    availableHeadroom,
    needed,
    restoredThisCycle,
  } = params;
  const toShed: DevicePlanDevice[] = [];
  let currentPotential = availableHeadroom;
  let effectiveHeadroom = Math.max(0, currentPotential - SWAP_RESTORE_RESERVE_KW);
  let admission = buildRestoreAdmissionMetrics({ availableKw: effectiveHeadroom, neededKw: needed });

  for (const onDev of onDevices) {
    if (!isViableSwapCandidate(onDev, dev, swappedOutFor, restoredThisCycle)) continue;

    const pwr = resolveCandidatePower(onDev);
    if (pwr === null || pwr <= 0) continue;

    toShed.push(onDev);
    currentPotential += pwr;
    effectiveHeadroom = Math.max(0, currentPotential - SWAP_RESTORE_RESERVE_KW);
    admission = buildRestoreAdmissionMetrics({ availableKw: effectiveHeadroom, neededKw: needed });

    if (admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) break;
  }

  const ready = admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW;
  const names = toShed.map((d) => d.name).join(', ');
  const reason = buildSwapCandidateReason({
    ready,
    targetName: dev.name,
    neededKw: needed,
    availableKw: currentPotential,
    effectiveAvailableKw: effectiveHeadroom,
    postReserveMarginKw: admission.postReserveMarginKw,
    shedNames: names,
  });

  return {
    ready,
    toShed,
    shedNames: names,
    shedPower: (currentPotential - availableHeadroom).toFixed(2),
    potentialHeadroom: currentPotential,
    effectiveHeadroom,
    admission,
    reserveKw: SWAP_RESTORE_RESERVE_KW,
    reason,
  };
}

function buildSwapCandidateReason(params: {
  ready: boolean;
  targetName: string;
  neededKw: number;
  availableKw: number;
  effectiveAvailableKw: number;
  postReserveMarginKw: number;
  shedNames: string;
}): DeviceReason {
  const {
    ready,
    targetName,
    neededKw,
    availableKw,
    effectiveAvailableKw,
    postReserveMarginKw,
    shedNames,
  } = params;

  if (ready) return { code: PLAN_REASON_CODES.swappedOut, targetName };

  const baseReason = buildRestoreHeadroomReason({
    neededKw,
    availableKw,
    effectiveAvailableKw,
    swapReserveKw: SWAP_RESTORE_RESERVE_KW,
    postReserveMarginKw,
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
    swapTargetName: targetName,
  });

  if (!shedNames) return baseReason;

  return {
    code: PLAN_REASON_CODES.other,
    text: `${formatDeviceReason(baseReason)} from ${shedNames}`,
  };
}

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

function resolvePendingOffRestoreHold(
  dev: DevicePlanDevice,
  pendingOffRestoreStepByDevice: Record<string, { stepId: string }>,
): { stepId: string } | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  if (resolveEffectiveCurrentOn(dev) !== false) return undefined;
  return pendingOffRestoreStepByDevice[dev.id];
}

function hasRecentPendingRestoreTimestamp(
  lastDeviceRestoreMs: Record<string, number>,
  deviceId: string,
  nowTs: number,
): boolean {
  const restoreMs = lastDeviceRestoreMs[deviceId];
  return Boolean(restoreMs && nowTs - restoreMs <= PENDING_RESTORE_WINDOW_MS);
}

function shouldReservePendingRestoreForDevice(params: {
  dev: DevicePlanDevice;
  steppedOffRestoreHold: { stepId: string } | undefined;
  lastDeviceRestoreMs: Record<string, number>;
  nowTs: number;
}): boolean {
  const { dev, steppedOffRestoreHold, lastDeviceRestoreMs, nowTs } = params;
  if (isSteppedLoadDevice(dev) && resolveEffectiveCurrentOn(dev) === false && !steppedOffRestoreHold) {
    return false;
  }
  if (!steppedOffRestoreHold && !hasRecentPendingRestoreTimestamp(lastDeviceRestoreMs, dev.id, nowTs)) {
    return false;
  }
  if (!dev.currentOn && !steppedOffRestoreHold) return false;
  return true;
}

/**
 * Returns the total power (kW) to reserve for recently restored devices whose elements
 * have not yet fired. Subtracting this from available headroom prevents back-to-back
 * restores from committing headroom that is still pending from the previous cycle.
 */
export function computePendingRestorePowerKw(
  planDevices: DevicePlanDevice[],
  lastDeviceRestoreMs: Record<string, number>,
  pendingOffRestoreStepByDevice: Record<string, { stepId: string }>,
  nowTs: number,
): { pendingKw: number; deviceIds: string[] } {
  let pendingKw = 0;
  const deviceIds: string[] = [];
  for (const dev of planDevices) {
    if (dev.plannedState === 'shed') continue;
    const steppedOffRestoreHold = resolvePendingOffRestoreHold(dev, pendingOffRestoreStepByDevice);
    if (!shouldReservePendingRestoreForDevice({
      dev,
      steppedOffRestoreHold,
      lastDeviceRestoreMs,
      nowTs,
    })) continue;
    const expectedKw = estimateRestorePower(dev);
    // Fall back to powerKw when measuredPowerKw is absent — some installations only
    // populate powerKw — so we don't treat a drawing device as drawing 0.
    const actualKw = Math.max(0, dev.measuredPowerKw ?? dev.powerKw ?? 0);
    if (actualKw >= expectedKw * PENDING_RESTORE_CONFIRMED_FRACTION) continue;
    const gap = expectedKw - actualKw;
    if (gap > 0) {
      pendingKw += gap;
      deviceIds.push(dev.id);
    }
  }
  return { pendingKw, deviceIds };
}

export function computeBaseRestoreNeed(dev: DevicePlanDevice): { power: number; buffer: number; needed: number } {
  const power = estimateRestorePower(dev);
  const buffer = computeRestoreBufferKw(power);
  return { power, buffer, needed: power + buffer };
}
