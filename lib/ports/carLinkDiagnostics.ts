import type { EvChargingState } from '../../packages/contracts/src/types';

/**
 * The car link as the car-link probe (`lib/device/`) sees it, for problem
 * reports (`lib/diagnostics/`). Neither layer may import the other, so the
 * shapes live here.
 */

/**
 * One car as the probe holds it, from the point of view of one charger.
 * `observed`: its plug state is readable. `outage`: Homey marked it unavailable
 * and no readable plug state has arrived since. `unread`: Homey lists it but it
 * has never reported a readable plug state. `unknown`: the probe does not track
 * it at all, so it has no name either.
 */
export type CarLinkCarStatus =
  | {
    availability: 'observed';
    carId: string;
    carName: string;
    state: EvChargingState;
    /** When the car's device last reported that plug state. */
    stateReportedAtMs: number;
    /** Past plug-ins of this car matched to this charger, kept for 90 days. */
    pastMatches: number;
  }
  | { availability: 'outage' | 'unread'; carId: string; carName: string; pastMatches: number }
  | { availability: 'unknown'; carId: string; pastMatches: number };

/**
 * When the probe saw a charger's current connection start. `plug_in`: it saw the
 * plug-in. `already_plugged_in_at_start`: the charger was plugged in when PELS
 * started, so the time is when PELS first saw it, not when it was plugged in.
 */
export type CarLinkConnection = { atMs: number; seen: 'plug_in' | 'already_plugged_in_at_start' };

/** The car link as it stands for one device, for a problem report. */
export type CarLinkDiagnostics =
  | {
    role: 'charger';
    /** `selected`: the owner selected cars for this charger. `any_car`: none, so any car may pair. */
    selection: 'selected' | 'any_car';
    /** The cars that may pair with this charger: its selected cars, or every car the probe tracks. */
    cars: readonly CarLinkCarStatus[];
    /** Absent when the charger is not plugged in. */
    connection?: CarLinkConnection;
    associatedCar?: { carId: string; carName: string };
    confirmedCar?: { carId: string; carName: string };
    /** When the current wait to identify the connected car started; absent when not waiting. */
    waitingSinceMs?: number;
  }
  | {
    role: 'car';
    /** The chargers that selected this car. */
    chargerIds: readonly string[];
    /** The charger this car is associated with now. */
    associatedChargerId?: string;
  };
