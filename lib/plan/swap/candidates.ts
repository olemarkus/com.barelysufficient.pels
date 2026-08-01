import type { DevicePlanDevice } from '../planTypes';
import { getCurrentDrawKw } from '../../observer/observedPower';
import {
  RESTORE_ADMISSION_FLOOR_KW,
  SWAP_RESTORE_RESERVE_KW,
} from '../planConstants';
import { buildRestoreAdmissionMetrics, type RestoreAdmissionMetrics } from '../admission';
import { buildRestoreHeadroomReason } from '../planReasonStrings';
import {
  formatDeviceReason,
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';

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
  // A NON-exempt target must not count freed draw from a budget-exempt source:
  // its budget axis is `budgetPaceKw + measuredExemptKw − total`, and turning
  // the exempt source off drops `measuredExemptKw` and `total` together — the
  // target's admission axis never grows, so the swap pauses a running exempt
  // device for a restore that is re-rejected every cycle until the swap times
  // out (strand + churn of exactly the device class the exemption protects).
  // Cost of the blanket rule: in a purely capacity-bound home a non-exempt
  // target can no longer swap out a lower-priority exempt source — a rare,
  // conservative narrowing that matches the exemption's intent.
  if (onDev.budgetExempt === true && dev.budgetExempt !== true) return false;
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
  // Reason-payload display values from the UNCLAMPED effective headroom —
  // `effectiveHeadroom`/`admission` stay clamped for the admission arithmetic.
  displayEffectiveHeadroomKw: number;
  displayPostReserveMarginKw: number;
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

    const pwr = getCurrentDrawKw(onDev);
    if (pwr <= 0) continue;

    toShed.push(onDev);
    currentPotential += pwr;
    effectiveHeadroom = Math.max(0, currentPotential - SWAP_RESTORE_RESERVE_KW);
    admission = buildRestoreAdmissionMetrics({ availableKw: effectiveHeadroom, neededKw: needed });

    if (admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) break;
  }

  const ready = admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW;
  const names = toShed.map((d) => d.name).join(', ');
  // Display values from the UNCLAMPED effective headroom. The `Math.max(0, …)`
  // clamp above protects the admission arithmetic, but a margin computed off
  // the clamped value flattens the displayed shortfall to `needed + reserves`
  // whenever `currentPotential < SWAP_RESTORE_RESERVE_KW` (deep over-pace),
  // understating the honest gap by however far potential sits below the
  // reserve — unbounded as overshoot grows. Admission keeps the clamped value;
  // both reject in that region, so control behavior is unchanged.
  const displayEffectiveHeadroomKw = currentPotential - SWAP_RESTORE_RESERVE_KW;
  const displayAdmission = buildRestoreAdmissionMetrics({
    availableKw: displayEffectiveHeadroomKw,
    neededKw: needed,
  });
  const reason = buildSwapCandidateReason({
    ready,
    targetName: dev.name,
    neededKw: needed,
    availableKw: currentPotential,
    effectiveAvailableKw: displayEffectiveHeadroomKw,
    postReserveMarginKw: displayAdmission.postReserveMarginKw,
    shedNames: names,
  });

  return {
    ready,
    toShed,
    shedNames: names,
    shedPower: (currentPotential - availableHeadroom).toFixed(2),
    potentialHeadroom: currentPotential,
    effectiveHeadroom,
    displayEffectiveHeadroomKw,
    displayPostReserveMarginKw: displayAdmission.postReserveMarginKw,
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
