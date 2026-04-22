import type { DevicePlanDevice } from './planTypes';
import { resolveCandidatePower } from './planCandidatePower';
import {
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
