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

/**
 * The session a charger was in when PELS last stopped.
 *
 * Persisted so a restart mid-charge can pick the session back up: a restart
 * observes no plug-in, because the plug-in already happened, so without this the
 * charger has no car until the next physical unplug/replug. Restored only as a
 * CANDIDATE — both the charger and that car must independently report connected
 * before it becomes an association again.
 *
 * Cleared when the session ends, so a stale pair can only survive an outage, not
 * a normal unplug.
 */
export type EvCarLinkSession = {
    carId: string;
    /** When the session was first committed, carried across the restart. */
    sinceMs: number;
};

export type EvCarLinkSnapshot = {
    version: EvCarLinkVersion;
    /** Keyed `${carId}|${chargerId}` — see `buildEvCarLinkPairKey`. */
    pairs: Record<string, EvCarLinkAffinity>;
    /** Keyed by car device id. */
    cars: Record<string, EvCarObservedStops>;
    /**
     * Keyed by charger device id. Absent on snapshots written before this
     * existed, which simply means no session can be resumed.
     */
    sessions?: Record<string, EvCarLinkSession>;
};
