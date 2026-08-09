/**
 * EV plug-state vocabulary: the device-identity predicate and the total
 * classification of what each plug-state means for PELS.
 *
 * Bottom of the EV stack — `commandableNow.ts` and `evObservedState.ts` build on
 * it, so nothing here may import them.
 *
 * **Every function here is total over `EvChargingState`, and none of them takes
 * or returns an absent value.** That is possible because the plug-state is a
 * capability contract, enforced where the contract is read: an `evcharger`
 * device must expose `evcharger_charging` AND `evcharger_charging_state`
 * (`transport/managerParse.ts`) AND that capability must carry a member of the
 * Homey enum (`transport/managerParseDeviceFields.ts`) — a device failing either
 * is dropped from the snapshot, exactly as a device with no control capability
 * is. So "EV device with an unknown plug-state" is not a state PELS represents;
 * it is a device PELS does not manage.
 *
 * That is why nothing downstream carries a derived plug-state bit any more. The
 * state itself is carried (required on `EvObservedFields` / `EvKind`) and every
 * question is answered from it here, at the point of use. Duplicating the
 * answers as flat fields is what produced the optional-and-nullable cluster this
 * replaced; `scripts/check-ev-vocab.mjs` is what keeps consumers calling these
 * functions instead of re-inlining `plugged_*` literals.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */
import type { EvChargingState } from '../../contracts/src/types';

/**
 * The two fields {@link isEvDevice} reads. Owned by the device producer, which
 * sets both for a real charger; consumers pass whatever carrier they hold and
 * never re-derive EV-ness from either field alone. Either signal alone is
 * sufficient — see {@link isEvDevice} for why the union is the contract.
 */
export type EvDeviceIdentity = { deviceClass?: string; controlCapabilityId?: string };

/**
 * EV-device predicate. A device is "EV" if EITHER its `deviceClass` is
 * `'evcharger'` OR its resolved binary control capability is
 * `'evcharger_charging'`. Real EV devices set both; the union collapses the two
 * historical gates into one source of truth. Returns `false` when both are
 * missing.
 */
export const isEvDevice = (dev: EvDeviceIdentity): boolean => (
  dev.deviceClass === 'evcharger' || dev.controlCapabilityId === 'evcharger_charging'
);

/**
 * Whether PELS may drive the charger, judged on plug-state alone (availability
 * and the resume-probe backoff are separate inputs, folded in by
 * `resolveCommandableNow`).
 *
 * **Only `plugged_out` and `plugged_in_discharging` block.** `plugged_in` does
 * NOT, and that is the point: the value is vendor-defined and inconsistent
 * across Homey apps. Easee maps "Awaiting Authentication" and "Ready to Charge"
 * to it (a start command is exactly what those want); Wallbox maps its `Paused`
 * state to it and never emits `plugged_in_paused` at all — so treating it as a
 * block let PELS's own pause create a state PELS then refused to leave. go-e and
 * Zaptec also use it for a finished session, where a start command is a no-op.
 * PELS probes that connected state and backs off when the charger does not start
 * (`lib/executor/evResumeReachability.ts`).
 *
 * The exhaustiveness guard is load-bearing: a new `EvChargingState` member must
 * be classified here rather than inheriting the commandable default.
 */
export const isEvPlugStateCommandable = (evChargingState: EvChargingState): boolean => {
  switch (evChargingState) {
    case 'plugged_out':
    case 'plugged_in_discharging':
      return false;
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return true;
    default: {
      const exhaustive: never = evChargingState;
      void exhaustive;
      return true;
    }
  }
};

/**
 * The plug-states that block, as a type predicate. Narrowing (rather than a bare
 * boolean) is what lets the owner-facing copy be a TOTAL record over the
 * blocking states — no fallback branch, no `null` for "nothing to say", and a
 * new blocking state cannot be added without a string for it.
 */
export const isEvPlugStateBlocked = (
  evChargingState: EvChargingState,
): evChargingState is EvBlockingChargingState => !isEvPlugStateCommandable(evChargingState);

/** The plug-states {@link isEvPlugStateCommandable} rejects. */
export type EvBlockingChargingState = Extract<
  EvChargingState,
  'plugged_out' | 'plugged_in_discharging'
>;

/**
 * No live, creditable charging session: the car is unplugged (`plugged_out`) or
 * it is exporting power back (`plugged_in_discharging`). In both, the charger
 * cannot be driven toward a SoC target and its state-of-charge cannot be
 * credited as progress.
 *
 * Classifies the same two states as {@link isEvPlugStateCommandable} today, and
 * stays a separate function because it answers a different question — "is there
 * a creditable session" versus "may we command it" — which a future plug-state
 * could separate.
 */
export const isEvSessionInactive = (evChargingState: EvChargingState): boolean => (
  evChargingState === 'plugged_out' || evChargingState === 'plugged_in_discharging'
);

/**
 * The bare connected state (`plugged_in` — distinct from `plugged_in_paused` /
 * `plugged_in_charging`): the car is plugged in and the charger reports no
 * active session. PELS still commands a charger in this state (see
 * {@link isEvPlugStateCommandable}), but it is NOT evidence that charge is
 * flowing, so the SoC behind it must not be credited as on-track objective
 * progress until the state moves to `plugged_in_charging`.
 */
export const isEvChargerNotResumable = (evChargingState: EvChargingState): boolean => (
  evChargingState === 'plugged_in'
);

/**
 * The EV resume-probe posture (`lib/executor/evResumeReachability.ts`):
 *
 * - `eligibleForStartProbe` — PELS may try to start this charger and learn from
 *   the outcome, which is what buys the 15/30/60 min backoff instead of a
 *   per-cycle retry.
 * - `activityObserved` — affirmative evidence that charge is flowing, which
 *   clears any recorded probe failure.
 */
export const resolveEvStartProbePosture = (evChargingState: EvChargingState): {
  eligibleForStartProbe: boolean;
  activityObserved: boolean;
} => ({
  eligibleForStartProbe: evChargingState === 'plugged_in' || evChargingState === 'plugged_in_paused',
  activityObserved: evChargingState === 'plugged_in_charging',
});
