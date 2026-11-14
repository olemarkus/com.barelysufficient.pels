/**
 * EV plug-state vocabulary: the device-identity predicate and the total
 * classification of what each plug-state means for PELS.
 *
 * Bottom of the EV stack — `commandableNow.ts` and `evObservedState.ts` build on
 * it, so nothing here may import them.
 *
 * These functions classify an accepted `EvChargingState`, never an absent
 * observation. Call them on observed state narrowed by `isEvObserved`, never
 * on a plan carrier whose producer already resolved the observation to facts.
 *
 * Charger identity can exist before a valid plug-state observation. Those
 * devices keep their independent observations, but callers must narrow through
 * `isEvObserved` before using this vocabulary. Missing state is never a
 * fabricated plug-in, plug-out or command grant.
 *
 * That is why nothing downstream carries a derived plug-state bit any more. The
 * state itself is carried (required on `EvObservedFields`, observer-side) and every
 * question is answered from it here, at the point of use. Duplicating the
 * answers as flat fields is what produced the optional-and-nullable cluster this
 * replaced; `scripts/check-ev-vocab.mjs` is what keeps consumers calling these
 * functions instead of re-inlining `plugged_*` literals.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */
import type { EvChargingState } from '../../contracts/src/types';

/**
 * The field {@link isEvDevice} reads: the producer-resolved EV identity
 * (`managerParseDeviceFields`), carried by the inventory descriptor and by
 * device configuration alike. Required, so a carrier without it is a build
 * error rather than a device that reads as "not a charger".
 */
export type EvDeviceIdentity = { isEvCharger: boolean };

// Membership set derived from a `satisfies Record<EvChargingState, …>` literal so
// a new union member is a compile error here until it's added to the guard (the
// Set keeps `has` off the prototype chain — `'toString' in record` would lie).
const EV_CHARGING_STATES: ReadonlySet<string> = new Set(
  Object.keys({
    plugged_in_charging: 0,
    plugged_in: 0,
    plugged_in_awaiting_start: 0,
    plugged_in_paused: 0,
    plugged_in_waiting_for_charger: 0,
    plugged_in_finished: 0,
    plugged_out: 0,
    plugged_in_discharging: 0,
  } satisfies Record<EvChargingState, 0>),
);

/**
 * The one guard that turns an untrusted value into an `EvChargingState`.
 *
 * It lives here, at the bottom of the EV stack, because BOTH ends of the app
 * need it and neither may import the other: the capability-read seam
 * (`lib/device/managerControl.getEvChargingState`) normalises a Homey enum read,
 * and the settings-UI parse seam (`planSnapshotParse`) validates the same field
 * arriving over the API bridge. Before this move the guard existed only in
 * `lib/device`, which the settings UI is forbidden to import — so the WebView
 * side declared the closed union on its wire type and then never checked it,
 * and a junk value reached `.trim()` in the card-text helpers.
 *
 * Everything else in this module is total over `EvChargingState` precisely
 * because this function is the only way in.
 */
export const isEvChargingState = (value: unknown): value is EvChargingState => (
  typeof value === 'string' && EV_CHARGING_STATES.has(value)
);

/**
 * EV-device predicate. The producer resolved it once, from class `evcharger`.
 * Nothing downstream re-reads the class.
 */
export const isEvDevice = (dev: EvDeviceIdentity): boolean => dev.isEvCharger;

/**
 * What PELS's wish to charge comes to in a session state: the one answer each
 * state admits.
 *
 * - `start`: no session runs, and a start command opens one.
 * - `resume`: the charger holds an open session off, and a resume lands.
 * - `keep`: the session delivers; PELS pauses it or sets its current.
 * - `offer`: the car has stopped asking. PELS keeps current on offer for when
 *   it asks again, and never starts a new session.
 * - `wait`: the next move is the charger's own. PELS sends nothing, and the
 *   session charges by itself once that move is made.
 * - `blocked`: no session can charge: no car, or the car exports power.
 */
export type EvChargeAction = 'start' | 'resume' | 'keep' | 'offer' | 'wait' | 'blocked';

/**
 * TOTAL over the session states, so a new `EvChargingState` member fails to
 * compile until it is given its action here.
 *
 * `plugged_in` is a `start` because the value is all an app that publishes
 * only Homey's enum can say about a car that takes no power: it covers a
 * charger that wants a start as well as a session that needs none, and a start
 * is what the first needs. Generic command confirmation handles the second
 * like any other device. An integration that can tell them apart resolves the
 * state that says so.
 */
const EV_CHARGE_ACTIONS: Record<EvChargingState, EvChargeAction> = {
  plugged_out: 'blocked',
  plugged_in_discharging: 'blocked',
  plugged_in: 'start',
  plugged_in_awaiting_start: 'start',
  plugged_in_paused: 'resume',
  plugged_in_charging: 'keep',
  plugged_in_waiting_for_charger: 'wait',
  plugged_in_finished: 'offer',
};

export const resolveEvChargeAction = (evChargingState: EvChargingState): EvChargeAction => (
  EV_CHARGE_ACTIONS[evChargingState]
);

/**
 * Whether PELS may drive the charger, judged on the session state alone
 * (availability is folded in by `resolveCommandableNow`): true wherever a
 * command of PELS's has an effect ({@link resolveEvChargeAction} is anything
 * but `wait` or `blocked`).
 *
 * A session the charger has not started blocks like an unplugged one: a start
 * there is refused, and the session begins by itself.
 */
export const isEvPlugStateCommandable = (evChargingState: EvChargingState): boolean => {
  const action = resolveEvChargeAction(evChargingState);
  return action !== 'wait' && action !== 'blocked';
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
  'plugged_out' | 'plugged_in_discharging' | 'plugged_in_waiting_for_charger'
>;

/**
 * A car is connected and takes no power, and no pause of the charger's holds
 * it: every connected state but charging, discharging and paused. What a car's
 * own plug reads while it sits at its charge limit or waits for its charger.
 */
export const isEvPlugStateIdle = (evChargingState: EvChargingState): boolean => {
  switch (evChargingState) {
    case 'plugged_in':
    case 'plugged_in_awaiting_start':
    case 'plugged_in_waiting_for_charger':
    case 'plugged_in_finished':
      return true;
    case 'plugged_in_charging':
    case 'plugged_in_paused':
    case 'plugged_in_discharging':
    case 'plugged_out':
      return false;
    default: {
      const exhaustive: never = evChargingState;
      void exhaustive;
      return false;
    }
  }
};

/**
 * No live, creditable charging session: the car is unplugged (`plugged_out`) or
 * it is exporting power back (`plugged_in_discharging`). In both, the charger
 * cannot be driven toward a SoC target and its state-of-charge cannot be
 * credited as progress.
 *
 * A different question from {@link isEvPlugStateCommandable}: a session the
 * charger has not started takes no command and is still a session whose state
 * of charge counts.
 */
export const isEvSessionInactive = (evChargingState: EvChargingState): boolean => (
  evChargingState === 'plugged_out' || evChargingState === 'plugged_in_discharging'
);

/**
 * Is a car physically attached?
 *
 * True for every `plugged_in*` state, INCLUDING `plugged_in_discharging` — a
 * V2G session is a car on the cable. That is what separates this from
 * {@link isEvSessionInactive}, which calls discharging inactive because no
 * charge is being credited: attachment and creditable-session are different
 * questions about the same state, and conflating them left a discharging
 * reconnect unable to anchor its session.
 *
 * This is what decides whether PELS has a battery level for a charger
 * (`lib/device/transport/stateOfCharge.ts`): a level belongs to the session it
 * was taken in, and the session ends when the car leaves. Nothing else retires
 * one — there is no age gate.
 */
export const isEvPlugStateConnected = (evChargingState: EvChargingState): boolean => (
  evChargingState !== 'plugged_out'
);
