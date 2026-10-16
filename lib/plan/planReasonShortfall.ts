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
 * The need MUST be the one the restore gate rejects on (`getRestoreNeed`,
 * `restore/support.ts`): a device measured against a smaller need than the gate
 * used can affirmatively resolve `no_gap` — the card claiming the device would be
 * admitted right now, on the very cycle the gate turned it down. Both therefore
 * price it with `computeRestoreRequirementKw`, recent-shed inflation included.
 *
 * Known deviations from the richest producer figures, all accepted for
 * freshness (the computation runs every cycle; producer numbers are snapshots
 * of the rejection that minted them and go stale across carry-forward cycles):
 *  - understates by the activation-penalty inflation. This one is NOT
 *    "computable but skipped": reproducing it means running
 *    `syncActivationPenaltyState`, which advances attempt/penalty state on
 *    `PlanEngineState` and must run exactly once per cycle, inside the restore
 *    pass. Reading the un-synced level instead would diverge from the gate in
 *    precisely the cycles where the level transitions. Bounded: a device deep
 *    enough in backoff to be blocked carries `activationBackoff` countdown copy,
 *    which attaches no kW at all;
 *  - understates by a live reserve claim on the `insufficient`-with-claim
 *    branch: `resolveReserveAdmission` hands back the RAW admission there,
 *    matching the restore gates exactly (parity, not a bug);
 *  - can overstate for a RUNNING stepped device denied a step-up: the need is
 *    the full restore power (`estimateRestorePower` → `planningPowerKw`), not
 *    the step-up increment the stepped gate admits on. Exposure is the
 *    swap-victim / carry-forward stepped corner; producer-resolved stepped
 *    admission numbers are refreshed whenever that lane actually runs.
 */
import type { DevicePlanDevice, MeteredDevicePlanDevice } from './planTypes';
import type { RestoreHeadroomLedger } from './restore/headroomLedger';
import { isReserveAdmitted, resolveReserveAdmission, type HeadroomReserve } from './admission';
import { computeRestoreRequirementKw, estimateRestorePower } from './restore/accounting';
import { buildSwapCandidates, type SwapLedger } from './swap';
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
  onDevices: readonly MeteredDevicePlanDevice[];
  swapLedger: SwapLedger;
  restoredThisCycle: ReadonlySet<string>;
  // Shed timestamps + this cycle's clock, so the need matches the restore gate's
  // recent-shed inflation (`computeRestoreRequirementKw`). Not optional: a missing
  // clock would silently deflate the need for exactly the devices most likely to
  // be held — the ones PELS shed minutes ago.
  lastDeviceShedMsById: Readonly<Record<string, number>>;
  nowMs: number;
};

// The kW that, if it became available, would let PELS run this device right
// now — including by swapping. Two gates, mirroring the restore lane exactly:
//
//  - plain admission: `needed − available`, i.e. the negated margin. Nothing is
//    withheld on top of the device's own inflated need, so the gap the card
//    states and the bar the gate applies are the same number;
//  - swap admission, when viable lower-priority victims are running
//    (`buildSwapCandidates`): the victims' draw folds INTO the available side
//    and the 0.3 kW swap reserve folds into the requirement, so the number is
//    `needed − victimDraw − available + swapReserve` — what must still appear
//    before PELS can act, not what the user must free by hand.
//
/**
 * Why the resolution ended where it did. The two no-number outcomes are NOT the
 * same fact and must not collapse into a bare `null`:
 *
 *  - `blocked_by_reserve` — raw power suffices; it is promised to a named device
 *    about to start. A gap through the reservation would state the HOLDER's
 *    quantity as this device's, so no kW is honest — but there IS an honest
 *    sentence, and the caller can only write it if it learns the cause here.
 *    Collapsing this into `null` is what left the card on the bare "Waiting to
 *    resume" whenever the restore lane had not run (fixed 2026-08-07).
 *  - `no_gap` — `admitted`/swap-ready, or a gap that rounds to nothing: the
 *    device would pass now, so the hold is a transient (cooldown, ordering),
 *    not a power gap. Nothing more specific to say.
 *
 * Resolution belongs in the producer (`docs/architecture.md`): this module owns
 * the admission arithmetic, so it reports the outcome rather than handing back a
 * number the consumer would have to reverse-engineer a cause from.
 */
export type CeilingShortfallResolution =
  | { kind: 'gap'; shortfallKw: number }
  // Carries the holder's name from the admission that produced it, so the caller
  // attaches a name it was handed rather than re-deriving one it would then have
  // to null-check.
  | { kind: 'blocked_by_reserve'; holderName: string }
  | { kind: 'no_gap' };

// The smaller (honest) gap wins; see `CeilingShortfallResolution` for the two
// outcomes that carry no number.
export function resolveCeilingShortfall(params: {
  dev: DevicePlanDevice;
  inputs: CeilingShortfallInputs;
}): CeilingShortfallResolution {
  const { dev, inputs } = params;
  const neededKw = computeRestoreRequirementKw(
    estimateRestorePower(dev), inputs.lastDeviceShedMsById[dev.id], inputs.nowMs,
  );
  const reserved = resolveReserveAdmission(dev, inputs.ledger.availableFor(dev), neededKw, inputs.headroomReserves);
  if (reserved.kind === 'blocked_by_reserve') {
    return { kind: 'blocked_by_reserve', holderName: reserved.holderName };
  }
  if (isReserveAdmitted(reserved)) return { kind: 'no_gap' };
  const plainGapKw = -reserved.admission.marginKw;

  // Swap-aware gap, off the reservation-adjusted base (the restore lane hands
  // the swap path `available − reservedKw` for the same reason — a swap must
  // not eat a promised block). `displayMarginKw` is the unclamped
  // variant, so deep over-pace gaps stay honest instead of flattening to
  // `needed + reserves`.
  const swap = buildSwapCandidates(
    dev,
    [...inputs.onDevices],
    inputs.swapLedger,
    reserved.availableKw - reserved.reservedKw,
    neededKw,
    inputs.restoredThisCycle,
  );
  const gapKw = swap.toShed.length > 0
    ? Math.min(plainGapKw, -swap.displayMarginKw)
    : plainGapKw;
  const shortfallKw = ceilToDisplayKw(gapKw);
  return shortfallKw === null ? { kind: 'no_gap' } : { kind: 'gap', shortfallKw };
}
