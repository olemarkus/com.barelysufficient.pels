import type { DevicePlanDevice } from './planTypes';
import { resolveCandidatePower } from './planCandidatePower';
import { isSteppedLoadDevice } from './planSteppedLoad';
import {
  PENDING_RESTORE_CONFIRMED_FRACTION,
  PENDING_RESTORE_WINDOW_MS,
  RESTORE_ADMISSION_FLOOR_KW,
  SWAP_RESTORE_RESERVE_KW,
} from './planConstants';
import { buildRestoreAdmissionMetrics, type RestoreAdmissionMetrics } from './planRestoreAdmission';
import { buildRestoreHeadroomReason } from './planReasonStrings';
import { resolveRestorePower as resolveSharedRestorePower } from './planPowerResolution';

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
  reason: string;
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
  const reason = ready
    ? `swapped out for ${dev.name}`
    : buildRestoreHeadroomReason({
      neededKw: needed,
      availableKw: currentPotential,
      effectiveAvailableKw: effectiveHeadroom,
      swapReserveKw: SWAP_RESTORE_RESERVE_KW,
      postReserveMarginKw: admission.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      swapTargetName: dev.name,
    }) + ` from ${names || 'none'}`;

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

export type RestorePowerSource = 'stepped' | 'planning' | 'expected' | 'measured' | 'configured' | 'fallback';

export function resolveRestorePowerSource(dev: DevicePlanDevice): RestorePowerSource {
  if (isSteppedLoadDevice(dev) && dev.steppedLoadProfile) return 'stepped';
  return resolveSharedRestorePower(dev).source as RestorePowerSource;
}

export function estimateRestorePower(dev: DevicePlanDevice): number {
  return resolveSharedRestorePower(dev).powerKw;
}

/**
 * Returns the total power (kW) to reserve for recently restored devices whose elements
 * have not yet fired. Subtracting this from available headroom prevents back-to-back
 * restores from committing headroom that is still pending from the previous cycle.
 */
export function computePendingRestorePowerKw(
  planDevices: DevicePlanDevice[],
  lastDeviceRestoreMs: Record<string, number>,
  nowTs: number,
): { pendingKw: number; deviceIds: string[] } {
  let pendingKw = 0;
  const deviceIds: string[] = [];
  for (const dev of planDevices) {
    if (dev.plannedState === 'shed') continue;
    const restoreMs = lastDeviceRestoreMs[dev.id];
    if (!restoreMs || nowTs - restoreMs > PENDING_RESTORE_WINDOW_MS) continue;
    // Non-stepped devices that are off are genuinely off — no latent load to reserve for.
    // Stepped loads are the exception: they remain currentOn=false during their confirmation
    // window even when a step-up command has already been issued.
    if (!dev.currentOn && !isSteppedLoadDevice(dev)) continue;
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
