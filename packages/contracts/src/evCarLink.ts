/**
 * Persisted shape for the EV car-to-charger link probe.
 *
 * TYPES ONLY — `packages/contracts` is stripped from the runtime bundle, so a
 * value export here crashes boot. The version constant and every normaliser
 * live in `lib/device/evCarLink.ts` (same split as
 * `powerCalibration.ts` ↔ `lib/device/devicePowerCalibration.ts`).
 *
 * The probe learns which car device belongs to which charger from coincident
 * plug/unplug transitions, and records the state-of-charge values at which a
 * car stops charging of its own accord. Both are observation-only: nothing in
 * this shape feeds planning, admission, or actuation.
 */

export type EvCarLinkVersion = 1;

/**
 * Accumulated evidence that one car belongs to one charger. Votes only ever
 * increase: an "away" session (car charged somewhere else) is silent evidence,
 * not counter-evidence, so it must never decrement this.
 */
export type EvCarLinkAffinity = {
    /** Coincident connect/disconnect edges observed for this pair. */
    votes: number;
    /** When this pair last earned a vote — drives pruning. */
    lastVotedAtMs: number;
};

/**
 * Per-car record of where the car stopped charging on its own. Repeated stops
 * clustering at one value are the car's charge limit; no Homey capability
 * carries an EV target SoC, so this inference is the only sanctioned route to
 * it. Newest sample last, bounded by `EV_CAR_LINK_MAX_STOP_SAMPLES`.
 */
export type EvCarObservedStops = {
    stopSocPct: number[];
    lastObservedAtMs: number;
};

export type EvCarLinkSnapshot = {
    version: EvCarLinkVersion;
    /** Keyed `${carId}|${chargerId}` — see `buildEvCarLinkPairKey`. */
    pairs: Record<string, EvCarLinkAffinity>;
    /** Keyed by car device id. */
    cars: Record<string, EvCarObservedStops>;
};
