import type { EvChargingState } from '../../contracts/src/types';
import { isOnLikeState } from './deviceStatePredicates';

/**
 * EV plug-state vocabulary: the raw Homey plug states read once, here, and turned
 * into the words users see. Raw plug-state strings live only in `lib/device` and
 * shared-domain (`scripts/check-ev-vocab.mjs`); the plan's status resolver and the
 * settings UI consume these resolved labels.
 */
/**
 * The plug state in the words users already read on the device card. Shared so a
 * car's state and its charger's state are never described differently — they are
 * observations of the same plug: the backend states a charger's plug in its
 * status, and the settings UI names a car's plug in the charger's car list.
 */
export const EV_CHARGING_STATE_LABELS: Readonly<Record<string, string>> = {
  plugged_in_charging: 'Charging',
  plugged_in_paused: 'Paused',
  plugged_in: 'Not charging',
  plugged_in_discharging: 'Discharging',
  plugged_out: 'Unplugged',
};

/**
 * Returns `null` for an unrecognised state rather than echoing the raw enum: a
 * capability id is not user-facing copy.
 */
export const resolveEvChargingStateLabel = (state: string | undefined): string | null => (
  state === undefined ? null : EV_CHARGING_STATE_LABELS[state] ?? null
);

// The plugged-in-idle state (`plugged_in`) upgrades to a car-attributed label
// only when the charger's own command (signal 2) says current is on offer (see
// `resolveSteppedEvExceptionLabel`).
const EV_IDLE_STATE = 'plugged_in';
const EV_IDLE_COMMANDED_LABEL = 'Waiting for car';
const EV_CAR_DISAGREES_LABEL = 'Car and charger disagree';
const EV_CAR_PAUSED_LABEL = 'Paused by the car';


// The routine "it's doing its thing" charging state: it folds into the fact line
// as `Charging · level 6 A`. Every other EV state (Paused / Not charging /
// Waiting for car / Discharging / Unplugged) is an exception, which leads the
// fact line instead (`resolveSteppedEvExceptionLabel`).
const EV_ROUTINE_STATE = 'plugged_in_charging';

export const EV_ROUTINE_CHARGING_LABEL = EV_CHARGING_STATE_LABELS[EV_ROUTINE_STATE];

export const isRoutineEvChargingState = (state: string | undefined): boolean => (
  (state ?? '').trim().toLowerCase() === EV_ROUTINE_STATE
);


const isChargerCommandedOn = (currentState: string | undefined): boolean => (
  isOnLikeState(currentState)
);

// Exceptional EV states for the fact line — null for the routine charging
// state (carried by the fact line) and for non-EV devices. The idle state
// (`plugged_in`) names the car as the holdout ("Waiting for car") only when the
// charger has been told to charge; a charger commanded off states the plain
// fact ("Not charging"), because nothing is waiting on a car that has not been
// offered any current.
//
// The claim is an observation rather than an inference, so it holds in
// simulation too and takes no `dryRun` argument: `toSimulationReasonLine`
// leaves factual device states alone by design.
export const resolveSteppedEvExceptionLabel = (device: {
  /** Observer-resolved "is current on offer": `off` when commanded off OR at a 0 W step. */
  currentState?: string;
  evChargingState?: EvChargingState;
  /** The associated car's own plug state; absent when no car is associated. */
  carChargingState?: EvChargingState;
  isEvCharger: boolean;
}): string | null => {
  if (!device.isEvCharger) return null;
  const state = (device.evChargingState ?? '').trim().toLowerCase();
  if (state === EV_ROUTINE_STATE) return null;
  const commandedOn = isChargerCommandedOn(device.currentState);
  const carLabel = resolveEvCarExceptionLabel(device, state, commandedOn);
  if (carLabel !== null) return carLabel;
  if (state === EV_IDLE_STATE && commandedOn) return EV_IDLE_COMMANDED_LABEL;
  return EV_CHARGING_STATE_LABELS[state] ?? null;
};

/**
 * What the associated CAR adds, and only where the charger alone is ambiguous.
 *
 * The charger table already decides the idle plug on its own — commanded on →
 * `Waiting for car`, commanded off → `Not charging`. What a car adds is the two
 * contradiction readings the charger can never produce by itself, plus
 * confirmation of a pause the charger only reports as its own. Matrix of
 * record: `notes/ev-charger-state-copy.md`.
 */
const resolveEvCarExceptionLabel = (
  device: { carChargingState?: EvChargingState },
  state: string,
  commandedOn: boolean,
): string | null => {
  const carState = device.carChargingState;
  if (carState === undefined) return null;
  // The charger reports current flowing, so whatever the car believes, this is
  // the routine case and the fact line already carries it.
  if (state === EV_ROUTINE_STATE) return null;
  if (state === EV_IDLE_STATE) {
    // A charger commanded off explains the idle plug by itself, and a car that
    // still reports charging is the expected lag behind that off command rather
    // than a fault — so neither the car-holdout claim nor the contradiction is
    // made here. Both need the charger to have been told to deliver current;
    // yielding leaves the caller to state the plain fact.
    if (!commandedOn) return null;
    // Both observe the same plug. Disagreement is a real fault — a lagging car
    // app or a wrong association — and is reported rather than smoothed over.
    if (carState === EV_ROUTINE_STATE) return EV_CAR_DISAGREES_LABEL;
    // The car says it is not plugged in at all, so the association is suspect.
    // Return the plain fact rather than falling through — falling through would
    // name the car as holdout on the strength of an association the car itself
    // just contradicted.
    if (carState === 'plugged_out') return EV_CHARGING_STATE_LABELS[state] ?? null;
    return EV_IDLE_COMMANDED_LABEL;
  }
  if (state === 'plugged_in_paused') {
    // Same contradiction as the idle case, and reported for the same reason: the
    // charger says it halted while the car says current is flowing.
    if (carState === EV_ROUTINE_STATE) return EV_CAR_DISAGREES_LABEL;
    if (carState === 'plugged_in_paused') return EV_CAR_PAUSED_LABEL;
  }
  return null;
};
