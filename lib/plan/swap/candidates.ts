import type { DevicePlanDevice } from '../planTypes';
import {
  RESTORE_ADMISSION_FLOOR_KW,
  SWAP_RESTORE_RESERVE_KW,
} from '../planConstants';
import { buildRestoreAdmissionMetrics, type RestoreAdmissionMetrics } from '../admission';
import { buildRestoreHeadroomReason } from '../planReasonStrings';
import {
  formatDeviceReason,
  PLAN_REASON_CODES,
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
  // The already-formatted decision sentence for the swap-rejection log lines
  // (`lib/plan/restore/swap.ts`). A STRING, not a `DeviceReason`: this value is
  // never a device's reason and never reaches a card. It used to be one — the
  // "with victims" case wrapped the formatted text back into a
  // `{ code: 'other', text }` object purely so both call sites could unwrap it
  // with `formatDeviceReason`, and that round-trip was the only producer of the
  // `other` code anywhere in the runtime.
  decisionText: string;
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

    const pwr = onDev.currentDrawKw;
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
  const decisionText = buildSwapCandidateDecisionText({
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
    decisionText,
  };
}

function buildSwapCandidateDecisionText(params: {
  ready: boolean;
  targetName: string;
  neededKw: number;
  availableKw: number;
  effectiveAvailableKw: number;
  postReserveMarginKw: number;
  shedNames: string;
}): string {
  const {
    ready,
    targetName,
    neededKw,
    availableKw,
    effectiveAvailableKw,
    postReserveMarginKw,
    shedNames,
  } = params;

  if (ready) return formatDeviceReason({ code: PLAN_REASON_CODES.swappedOut, targetName });

  // No swap-target clause in the reject text. `insufficientHeadroom` used to
  // carry a `swapTargetName` purely to prefix this one string, and the name it
  // stated is `dev.name` — the same value the enclosing debug payload already
  // logs as `deviceName`, one field away (`lib/plan/restore/swap.ts`). Carrying a
  // slot on every device's reason to duplicate a sibling log field is not worth a
  // permanently-null field in the plan contract, so the slot is gone and the text
  // reads as the plain restore-side rejection it is; `restoreType: 'swap'` and
  // `shedNames` still identify it as the swap path.
  const baseText = formatDeviceReason(buildRestoreHeadroomReason({
    neededKw,
    availableKw,
    effectiveAvailableKw,
    swapReserveKw: SWAP_RESTORE_RESERVE_KW,
    postReserveMarginKw,
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
  }));

  return shedNames ? `${baseText} from ${shedNames}` : baseText;
}
