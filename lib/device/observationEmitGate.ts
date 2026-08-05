/**
 * Change-gate for the read-only observation producers' structured events.
 *
 * The battery and solar producers built by `createObservationProducers` emit on
 * EVERY successful device fetch — roughly once a minute. Their payloads are
 * point-in-time observations of a value, so an unchanged repeat carries no
 * information: a production-flat evening logged
 * `solar_production_observed` with the same watts ~40 times in a row, and the
 * event alone accounted for ~90% of the lines in a user's diagnostics report,
 * crowding out what we had asked them to send.
 *
 * The gate lives HERE, in the wiring seam, rather than inside the producers on
 * purpose: `SolarProductionProducer` and `BatteryStateProducer` both document
 * "There is NO retained value — a point-in-time successful observation is
 * surfaced purely as the structured event", and `createObservationProducers`
 * repeats it ("battery and solar retain nothing"). A `lastEmitted` field on
 * either would contradict that contract and mint a retained value a future
 * consumer could read. Deduplication state is a property of the LOG SINK, not
 * of an observation, so it belongs on this side of the seam.
 *
 * CONTRACT FOR CALLERS: only route events whose repeat COUNT is meaningless
 * through this gate. An observation of a value qualifies — the value is the
 * message. An event meaning "this happened again" must not, because identical
 * repeats are exactly its signal. That is why the third producer built
 * alongside these two, the EV car-link probe, is deliberately NOT routed
 * through here: `ev_car_link_ambiguous` / `ev_car_link_resolved` /
 * `ev_car_self_stopped` are discrete occurrences, and the ambiguous payload in
 * particular is fully static, so gating it would swallow a real second event.
 */

/**
 * How long an unchanged payload stays suppressed before one heartbeat re-emit.
 *
 * Change-only would be tighter, but a value that legitimately sits flat (0 W of
 * production overnight) would then produce no evidence at all that the
 * observation path is still alive — and "PV stopped being read" vs "PV is
 * reading zero" is precisely the distinction a diagnostics report has to
 * support. Bounds the steady-state worst case at ~4 lines/hour per event rather
 * than ~60.
 */
export const OBSERVATION_EMIT_HEARTBEAT_MS = 15 * 60 * 1000;

type ObservationPayload = Record<string, unknown>;

type LastEmitted = {
    payload: ObservationPayload;
    atMs: number;
};

/**
 * Shallow equality over own enumerable keys, with a deliberate FAIL-OPEN on any
 * non-scalar value: a nested object/array compares unequal, so the payload is
 * emitted rather than deep-compared. Observation payloads are flat scalars, so
 * this is exact for every real case, and the failure mode for a future nested
 * payload is an extra log line — never a suppressed change.
 */
const isScalar = (value: unknown): boolean => (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
);

const isUnchanged = (previous: ObservationPayload, next: ObservationPayload): boolean => {
    const previousKeys = Object.keys(previous);
    if (previousKeys.length !== Object.keys(next).length) return false;
    return previousKeys.every((key) => {
        if (!Object.prototype.hasOwnProperty.call(next, key)) return false;
        const previousValue = previous[key];
        const nextValue = next[key];
        if (!isScalar(previousValue) || !isScalar(nextValue)) return false;
        return Object.is(previousValue, nextValue);
    });
};

/**
 * Wraps a structured-log sink so an unchanged payload is emitted at most once
 * per {@link OBSERVATION_EMIT_HEARTBEAT_MS}. Each `event` name is tracked
 * independently; a payload carrying no usable `event` string is passed straight
 * through ungated (nothing to key on — fail open, never swallow).
 *
 * `now` is injected so the heartbeat is testable without fake timers.
 */
export const createObservationEmitGate = (params: {
    emit: (payload: ObservationPayload) => void;
    now?: () => number;
}): ((payload: ObservationPayload) => void) => {
    const now = params.now ?? (() => Date.now());
    const lastByEvent = new Map<string, LastEmitted>();
    return (payload: ObservationPayload): void => {
        const event = typeof payload.event === 'string' && payload.event !== '' ? payload.event : null;
        if (event === null) {
            params.emit(payload);
            return;
        }
        const nowMs = now();
        const previous = lastByEvent.get(event);
        if (
            previous !== undefined
            && isUnchanged(previous.payload, payload)
            && nowMs - previous.atMs < OBSERVATION_EMIT_HEARTBEAT_MS
        ) {
            // Suppressed: deliberately do NOT refresh `atMs`, so the heartbeat
            // measures time since the last EMISSION. Refreshing it on every
            // suppressed repeat would push the deadline out forever and the
            // heartbeat would never fire.
            return;
        }
        lastByEvent.set(event, { payload, atMs: nowMs });
        params.emit(payload);
    };
};
