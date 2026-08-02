/**
 * Per-cycle admission shortfall for ceiling-held devices, computed at the
 * reason-normalization stage (`normalizeShedReasons`).
 *
 * Why here and not at a producer: the restore lane attaches admission numbers
 * only when it actually evaluates a device, and it never does in exactly the
 * deep-hold states where the card matters most — a device shed this cycle is
 * not a restore candidate, the whole restore pass is skipped while the house is
 * over pace or in cooldown, and the set_temperature hold lane re-asserts its
 * base reason without consulting admission. Prod 2026-08-02: five devices held
 * on a 0.55 kW daily pace rendered the bare "Waiting to resume" because not a
 * single restore was evaluated all session. This module closes that gap by
 * running the SAME admission arithmetic the restore gates use, against the
 * post-hold per-axis ledger, for any held device whose reason carries no
 * producer-resolved number.
 *
 * The gap is pace-relative — room under the safe pace, not freeable appliance
 * load (`notes/safe-pace-two-constraints.md`; the pace itself recovers over
 * time, so the number may exceed instantaneous house draw and still be true).
 *
 * Known deviations from the richest producer figures, all accepted for
 * freshness (the computation runs every cycle; producer numbers are snapshots
 * of the rejection that minted them and go stale across carry-forward cycles):
 *  - understates by the activation-penalty inflation: the need comes from
 *    `computeBaseRestoreNeed` (pure), not `getRestoreNeed`, which folds the
 *    penalty in but mutates `PlanEngineState` — unsafe outside the restore
 *    pass. Backoff devices carry `activationBackoff` countdown copy anyway;
 *  - understates by a live reserve claim on the `insufficient`-with-claim
 *    branch: `resolveReserveAdmission` hands back the RAW admission there,
 *    matching the restore gates exactly (parity, not a bug);
 *  - can overstate for a RUNNING stepped device denied a step-up: the need is
 *    the full restore power (`estimateRestorePower` → `planningPowerKw`), not
 *    the step-up increment the stepped gate admits on. Exposure is the
 *    swap-victim / carry-forward stepped corner; producer-resolved stepped
 *    admission numbers are refreshed whenever that lane actually runs.
 */
import type { DevicePlanDevice } from './planTypes';
import type { RestoreHeadroomLedger } from './restore/headroomLedger';
import { buildRestoreHeadroomLedger } from './restore/headroomLedger';
import { resolveReserveAdmission, type HeadroomReserve } from './admission';
import { computeBaseRestoreNeed } from './restore/accounting';
import { buildSwapCandidates } from './swap/candidates';
import { RESTORE_ADMISSION_FLOOR_KW } from './planConstants';
import { ceilToDisplayKw } from '../../packages/shared-domain/src/planReasonSemantics';

// The per-cycle admission context the shortfall computation gates against —
// per-axis availability, startup reservations, and the swap surface (running
// devices + swap state), resolved once per cycle by the restore/hold passes
// and threaded through `normalizeShedReasons`.
export type CeilingShortfallInputs = {
  ledger: RestoreHeadroomLedger;
  headroomReserves: readonly HeadroomReserve[];
  // Swap surface: PELS can free a viable lower-priority device's draw on its
  // own, so the honest "more needed" folds that relief in — without it the
  // card overstates the wait by exactly the power a swap would free.
  // MUST be the swap lane's own victim filter (`getOnDevices`,
  // `lib/plan/restore/devices.ts`), never raw plan devices: the raw list
  // contains devices a swap can never shed (stepped `set_step` behavior,
  // thermostats at their shed floor, uncommandable devices), and folding their
  // draw would UNDERSTATE the gap — the one error direction this module must
  // never take.
  onDevices: readonly DevicePlanDevice[];
  swappedOutFor: ReadonlyMap<string, string>;
  restoredThisCycle: ReadonlySet<string>;
};

export function buildCeilingShortfallInputs(params: {
  ledgerAxes: { capacityAvailableKw: number; budgetAvailableKw: number | null };
  headroomReserves: readonly HeadroomReserve[];
  onDevices: readonly DevicePlanDevice[];
  swappedOutFor: ReadonlyMap<string, string>;
  restoredThisCycle: ReadonlySet<string>;
}): CeilingShortfallInputs {
  return {
    ledger: buildRestoreHeadroomLedger(params.ledgerAxes),
    headroomReserves: params.headroomReserves,
    onDevices: params.onDevices,
    swappedOutFor: params.swappedOutFor,
    restoredThisCycle: params.restoredThisCycle,
  };
}

// The kW that, if it became available, would let PELS run this device right
// now — including by swapping. Two gates, mirroring the restore lane exactly:
//
//  - plain admission: `RESTORE_ADMISSION_FLOOR_KW − postReserveMarginKw`
//    (`postReserveMargin = available − needed − RESERVE`);
//  - swap admission, when viable lower-priority victims are running
//    (`buildSwapCandidates`): the victims' draw folds INTO the available side
//    and the 0.3 kW swap reserve folds into the requirement, so the number is
//    `needed − victimDraw − available + margins` — what must still appear
//    before PELS can act, not what the user must free by hand.
//
// The smaller (honest) gap wins. `null` when no number is honest:
//  - the reserve carve-out (`blocked_by_reserve`): raw power suffices but is
//    promised to a device about to start — a gap through the reservation would
//    state the holder's quantity as this device's;
//  - `admitted` / swap-ready: the device would pass now, so the hold is a
//    transient (cooldown/ordering), not a power gap;
//  - a gap that rounds to nothing.
export function resolveCeilingShortfallKw(params: {
  dev: DevicePlanDevice;
  inputs: CeilingShortfallInputs;
}): number | null {
  const { dev, inputs } = params;
  const neededKw = computeBaseRestoreNeed(dev).needed;
  const reserved = resolveReserveAdmission({
    dev,
    availableHeadroom: inputs.ledger.availableFor(dev),
    neededKw,
    reserves: inputs.headroomReserves,
  });
  if (reserved.kind === 'blocked_by_reserve') return null;
  const plainGapKw = RESTORE_ADMISSION_FLOOR_KW - reserved.admission.postReserveMarginKw;

  // Swap-aware gap, off the reservation-adjusted base (the restore lane hands
  // the swap path `available − reservedKw` for the same reason — a swap must
  // not eat a promised block). `displayPostReserveMarginKw` is the unclamped
  // variant, so deep over-pace gaps stay honest instead of flattening to
  // `needed + reserves`.
  const swap = buildSwapCandidates({
    dev,
    onDevices: [...inputs.onDevices],
    swappedOutFor: inputs.swappedOutFor,
    availableHeadroom: reserved.effectiveHeadroomKw,
    needed: neededKw,
    restoredThisCycle: inputs.restoredThisCycle,
  });
  const gapKw = swap.toShed.length > 0
    ? Math.min(plainGapKw, RESTORE_ADMISSION_FLOOR_KW - swap.displayPostReserveMarginKw)
    : plainGapKw;
  return ceilToDisplayKw(gapKw);
}
