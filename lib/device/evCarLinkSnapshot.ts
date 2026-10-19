/**
 * Persisted-shape half of the EV car-to-charger link probe: version constant,
 * boundary normalisation, vote accumulation, self-stop sampling, and pruning.
 *
 * Split from `evCarLink.ts` (the correlation decisions) so each file stays under
 * the 500 LOC cap and so the persistence concerns are testable without the
 * matcher. The store that persists it lives in `evCarLinkStore.ts`.
 *
 * Everything here is pure. Partial persisted records are dropped rather than
 * thrown on — the same defensive contract as
 * `normalizePersistedPowerCalibration`.
 */
import type {
    EvCarChargerMatch,
    EvCarLinkAffinity,
    EvCarLinkSession,
    EvCarLinkSnapshot,
    EvCarLinkVersion,
    EvCarObservedStops,
} from '../../packages/contracts/src/evCarLink';

/**
 * Runtime version constant for {@link EvCarLinkSnapshot}. Defined here (not in
 * the contracts package) so Homey runtime code does not value-import from
 * `packages/contracts/src/**`, which is deploy-excluded.
 */
export const EV_CAR_LINK_VERSION: EvCarLinkVersion = 2;

/**
 * The version before stop samples had to be the car's own. Version 1 banked a
 * sample whenever the car reported not-charging against a charger that read
 * "on", and on an Easee that includes PELS's own resume during its hold-off: the
 * only sample production ever banked (2026-09-15, 42 %) came two minutes after
 * PELS switched the charger on. A v1 blob still loads — its pairs and sessions
 * are sound evidence and are kept — but its stop samples are dropped, so no
 * limit is ever qualified from them.
 */
const EV_CAR_LINK_VERSION_WITH_UNSOUND_STOPS = 1;

/** Retained self-stop samples per car — enough to see a cluster, bounded for RSS. */
export const EV_CAR_LINK_MAX_STOP_SAMPLES = 20;

/** Pair/car records untouched for this long are dropped (matches calibration). */
export const EV_CAR_LINK_PRUNE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Upper bound on tracked cars, so a large Homey cannot grow this without limit. */
export const EV_CAR_LINK_MAX_TRACKED_CARS = 8;

export const createEmptyEvCarLinkSnapshot = (): EvCarLinkSnapshot => ({
    version: EV_CAR_LINK_VERSION,
    pairs: {},
    cars: {},
    sessions: {},
});

export const buildEvCarLinkPairKey = (carId: string, chargerId: string): string => `${carId}|${chargerId}`;

/**
 * Split a pair key back into its two device ids. Returns `null` for any key that
 * is not exactly two non-empty segments, so a hand-edited or corrupted settings
 * blob cannot produce a half-formed pair.
 */
export const parseEvCarLinkPairKey = (key: string): { carId: string; chargerId: string } | null => {
    const parts = key.split('|');
    if (parts.length !== 2) return null;
    const [carId, chargerId] = parts;
    if (carId === undefined || chargerId === undefined) return null;
    if (carId.length === 0 || chargerId.length === 0) return null;
    return { carId, chargerId };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFinitePositive = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
);

const isKnownEvCarLinkVersion = (value: unknown): boolean => (
    value === EV_CAR_LINK_VERSION || value === EV_CAR_LINK_VERSION_WITH_UNSOUND_STOPS
);

const isValidSocPct = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
);

const normalizeAffinity = (value: unknown): EvCarLinkAffinity | null => {
    if (!isRecord(value)) return null;
    const { votes, lastVotedAtMs } = value;
    if (!isFinitePositive(votes)) return null;
    if (!isFinitePositive(lastVotedAtMs)) return null;
    return { votes: Math.floor(votes), lastVotedAtMs };
};

const normalizeObservedStops = (value: unknown): EvCarObservedStops | null => {
    if (!isRecord(value)) return null;
    const { stopSocPct, lastObservedAtMs } = value;
    if (!isFinitePositive(lastObservedAtMs)) return null;
    if (!Array.isArray(stopSocPct)) return null;
    const samples = stopSocPct.filter(isValidSocPct);
    if (samples.length === 0) return null;
    return {
        stopSocPct: samples.slice(-EV_CAR_LINK_MAX_STOP_SAMPLES),
        lastObservedAtMs,
    };
};

/**
 * Returns a defensively-typed snapshot, or `null` for a value that is not a
 * snapshot of a known version at all; partial pair/car records are dropped
 * silently. Use this whenever a snapshot crosses the persistence boundary.
 */
export const normalizeEvCarLinkSnapshot = (value: unknown, nowMs: number): EvCarLinkSnapshot | null => {
    if (!isRecord(value)) return null;
    if (!isKnownEvCarLinkVersion(value.version)) return null;
    const pairsRaw = value.pairs;
    const carsRaw = value.version === EV_CAR_LINK_VERSION_WITH_UNSOUND_STOPS ? {} : value.cars;
    if (!isRecord(pairsRaw) || !isRecord(carsRaw)) return null;

    // Clamp any timestamp that sits in the future to the load-time clock. A
    // Homey clock jump mid-vote, or a corrupt persisted value, otherwise makes
    // `pruneEvCarLinkSnapshot` compute a NEGATIVE age that always satisfies the
    // retention check — so the record never expires and can keep qualifying as an
    // affinity prior forever. Clamping is conservative: the record simply starts
    // ageing from now instead of being trusted indefinitely.
    const clamp = (timestampMs: number): number => Math.min(timestampMs, nowMs);
    const pairs = Object.entries(pairsRaw).flatMap(([key, raw]) => {
        if (parseEvCarLinkPairKey(key) === null) return [];
        const normalized = normalizeAffinity(raw);
        return normalized
            ? [[key, { ...normalized, lastVotedAtMs: clamp(normalized.lastVotedAtMs) }] as const]
            : [];
    });
    // Absent on snapshots written before sessions were persisted, which just
    // means nothing can be resumed — never a reason to discard the whole blob.
    const sessionsRaw = isRecord(value.sessions) ? value.sessions : {};
    const sessions = Object.entries(sessionsRaw).flatMap(([chargerId, raw]) => {
        if (chargerId.length === 0 || !isRecord(raw)) return [];
        const { carId, sinceMs } = raw;
        if (typeof carId !== 'string' || carId.length === 0) return [];
        if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || sinceMs < 0) return [];
        return [[chargerId, {
            carId, sinceMs: clamp(sinceMs), ...(raw.confirmed === true ? { confirmed: true as const } : {}),
        }] as const];
    });
    const cars = Object.entries(carsRaw).flatMap(([carId, raw]) => {
        if (carId.length === 0) return [];
        const normalized = normalizeObservedStops(raw);
        return normalized
            ? [[carId, { ...normalized, lastObservedAtMs: clamp(normalized.lastObservedAtMs) }] as const]
            : [];
    });

    return {
        version: EV_CAR_LINK_VERSION,
        pairs: Object.fromEntries(pairs),
        cars: Object.fromEntries(cars.slice(0, EV_CAR_LINK_MAX_TRACKED_CARS)),
        sessions: Object.fromEntries(sessions.slice(0, EV_CAR_LINK_MAX_TRACKED_CARS)),
    };
};

/**
 * A legacy settings value as its import reads it: {@link normalizeEvCarLinkSnapshot},
 * and `null` as well when the value carried entries none of which hold. That
 * is a malformed read rather than an empty snapshot, so the import leaves the
 * key (`lib/store/legacySettingsImport.ts`). A version-1 value's stop samples
 * are dropped by rule, not as malformed, so they do not count: such a value
 * carrying only stops is empty, and adopts.
 */
export const normalizeLegacyEvCarLinkSnapshot = (value: unknown, nowMs: number): EvCarLinkSnapshot | null => {
    const snapshot = normalizeEvCarLinkSnapshot(value, nowMs);
    if (snapshot === null || !isRecord(value)) return null;
    const carried = entryCount(value.pairs) + entryCount(value.sessions)
        + (value.version === EV_CAR_LINK_VERSION_WITH_UNSOUND_STOPS ? 0 : entryCount(value.cars));
    const held = entryCount(snapshot.pairs) + entryCount(snapshot.cars) + entryCount(snapshot.sessions);
    return carried > 0 && held === 0 ? null : snapshot;
};

const entryCount = (value: unknown): number => (isRecord(value) ? Object.keys(value).length : 0);

/** Records the session a charger is in, so a restart can offer to resume it. */
export const recordEvCarLinkSession = (
    snapshot: EvCarLinkSnapshot,
    chargerId: string,
    session: EvCarLinkSession,
): EvCarLinkSnapshot => ({
    ...snapshot,
    sessions: { ...snapshot.sessions, [chargerId]: session },
});

/**
 * Forgets a charger's session. Called on every normal session end, so a
 * persisted session can only ever survive an outage — never an unplug PELS saw.
 */
export const clearEvCarLinkSession = (params: {
    snapshot: EvCarLinkSnapshot;
    chargerId: string;
}): EvCarLinkSnapshot => {
    const { [params.chargerId]: removed, ...rest } = params.snapshot.sessions;
    return removed === undefined ? params.snapshot : { ...params.snapshot, sessions: rest };
};

/**
 * Add one coincidence vote to a pair. Votes only ever increase: an away session
 * carries no counter-evidence, so there is deliberately no decrement path.
 */
export const recordEvCarLinkVote = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
    chargerId: string,
    nowMs: number,
): EvCarLinkSnapshot => {
    const key = buildEvCarLinkPairKey(carId, chargerId);
    const previous = snapshot.pairs[key];
    return {
        ...snapshot,
        pairs: {
            ...snapshot.pairs,
            [key]: { votes: (previous?.votes ?? 0) + 1, lastVotedAtMs: nowMs },
        },
    };
};

export const getEvCarLinkVotes = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
    chargerId: string,
): number => snapshot.pairs[buildEvCarLinkPairKey(carId, chargerId)]?.votes ?? 0;

/**
 * The chargers this car has been matched to, newest first. A pair with no votes
 * is not a match. Pruning bounds the history, so this covers the retained window
 * (`EV_CAR_LINK_PRUNE_MAX_AGE_MS`), not all time.
 */
export const resolveEvCarChargerMatches = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
): EvCarChargerMatch[] => {
    const matches = Object.entries(snapshot.pairs).flatMap(([key, affinity]) => {
        const pair = parseEvCarLinkPairKey(key);
        if (pair?.carId !== carId || affinity.votes <= 0) return [];
        return [{ chargerId: pair.chargerId, lastMatchedAtMs: affinity.lastVotedAtMs }];
    });
    return [...matches].sort((left, right) => right.lastMatchedAtMs - left.lastMatchedAtMs);
};

/**
 * Record the state-of-charge at which a car stopped charging on its own.
 *
 * Out-of-range readings are dropped rather than clamped — a clamped 0 or 100
 * would pollute the cluster the caller is trying to read. A car not yet tracked
 * is only admitted while under `EV_CAR_LINK_MAX_TRACKED_CARS`; already-tracked
 * cars always accept samples so a full table cannot silently freeze one car's
 * history.
 */
export const recordEvCarSelfStopSoc = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
    socPct: number,
    nowMs: number,
): EvCarLinkSnapshot => {
    if (!isValidSocPct(socPct)) return snapshot;
    const previous = snapshot.cars[carId];
    if (!previous && Object.keys(snapshot.cars).length >= EV_CAR_LINK_MAX_TRACKED_CARS) return snapshot;
    const stopSocPct = [...(previous?.stopSocPct ?? []), socPct].slice(-EV_CAR_LINK_MAX_STOP_SAMPLES);
    return {
        ...snapshot,
        cars: { ...snapshot.cars, [carId]: { stopSocPct, lastObservedAtMs: nowMs } },
    };
};

export type EvCarObservedLimit = {
    /** Median of the retained stop samples — the candidate charge limit. */
    medianPct: number;
    /** Max minus min across retained samples; a tight spread means a real limit. */
    spreadPct: number;
    sampleCount: number;
};

/**
 * Summarise where a car repeatedly stops. Reported as median plus spread rather
 * than a single number so a reader can tell a genuine charge limit (many samples,
 * near-zero spread) from a car that simply gets unplugged at varying levels.
 * Returns `null` below two samples — one stop proves nothing.
 */
export const summarizeEvCarObservedLimit = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
): EvCarObservedLimit | null => summarizeStopSamples(snapshot.cars[carId]?.stopSocPct ?? []);

const summarizeStopSamples = (samples: readonly number[]): EvCarObservedLimit | null => {
    if (samples.length < 2) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    // Two samples minimum, so every index below is in range; reading them as locals is
    // what makes that visible rather than asserted.
    const lowerMiddle = sorted[middle - 1];
    const upperMiddle = sorted[middle];
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];
    if (
        lowerMiddle === undefined
        || upperMiddle === undefined
        || lowest === undefined
        || highest === undefined
    ) return null;
    const medianPct = sorted.length % 2 === 0
        ? (lowerMiddle + upperMiddle) / 2
        : upperMiddle;
    return {
        medianPct: Math.round(medianPct * 10) / 10,
        spreadPct: Math.round((highest - lowest) * 10) / 10,
        sampleCount: sorted.length,
    };
};

/** How many of the newest stops a charge limit is judged on. */
export const EV_CAR_LINK_LIMIT_WINDOW_SAMPLES = 3;

/** Widest spread across that window that still reads as one limit. */
export const EV_CAR_LINK_LIMIT_MAX_SPREAD_PCT = 2;

/**
 * The car's charge limit, once its recent stops agree on one: the LOWEST of the
 * newest {@link EV_CAR_LINK_LIMIT_WINDOW_SAMPLES} stops, when there are at least
 * two and they lie within {@link EV_CAR_LINK_LIMIT_MAX_SPREAD_PCT} of each other.
 * `null` otherwise — one stop proves nothing, and stops scattered across a range
 * are an owner unplugging at varying levels, not a setting. Judged on the newest
 * stops only, so a limit the owner changes is relearned in two sessions instead
 * of being outvoted by the old one.
 *
 * The lowest, not the median, because every stop in the window is a level the
 * car is known to reach. A car stopping either side of its setting (70 and 71)
 * can therefore be recognized at its own limit on either stop. This explains
 * device delivery; it never lowers a smart task's requested target or completes it.
 */
export const resolveEvCarChargeLimit = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
): number | null => {
    const recentStops = (snapshot.cars[carId]?.stopSocPct ?? []).slice(-EV_CAR_LINK_LIMIT_WINDOW_SAMPLES);
    const summary = summarizeStopSamples(recentStops);
    if (summary === null || summary.spreadPct > EV_CAR_LINK_LIMIT_MAX_SPREAD_PCT) return null;
    return Math.min(...recentStops);
};

/** Forgets every stop a car has banked — its limit is relearned from scratch. */
export const clearEvCarObservedStops = (
    snapshot: EvCarLinkSnapshot,
    carId: string,
): EvCarLinkSnapshot => {
    const { [carId]: removed, ...rest } = snapshot.cars;
    return removed === undefined ? snapshot : { ...snapshot, cars: rest };
};

/** Drop pair and car records untouched for longer than `maxAgeMs`. */
export const pruneEvCarLinkSnapshot = (
    snapshot: EvCarLinkSnapshot,
    nowMs: number,
    maxAgeMs: number = EV_CAR_LINK_PRUNE_MAX_AGE_MS,
): EvCarLinkSnapshot => {
    const pairs = Object.entries(snapshot.pairs)
        .filter(([, affinity]) => nowMs - affinity.lastVotedAtMs <= maxAgeMs);
    const cars = Object.entries(snapshot.cars)
        .filter(([, stops]) => nowMs - stops.lastObservedAtMs <= maxAgeMs);
    if (pairs.length === Object.keys(snapshot.pairs).length && cars.length === Object.keys(snapshot.cars).length) {
        return snapshot;
    }
    return {
        version: EV_CAR_LINK_VERSION,
        pairs: Object.fromEntries(pairs),
        cars: Object.fromEntries(cars),
        // Carried through: pruning ages out EVIDENCE, and a live session is not
        // evidence. Rebuilding without it meant one stale pair at boot silently
        // dropped every session, so a mid-charge restart lost its car.
        sessions: snapshot.sessions,
    };
};

/**
 * A legacy settings value under what the store already holds. The store fills
 * from an empty boot (a deferred import still lets the probe vote), and
 * writing the legacy value alone would overwrite the multi-session evidence
 * gathered since. A completed import is marked and never merges again
 * (`evCarLinkStore.ts`), so this runs after a deferred import, or after one
 * that completed before imports were marked and whose unset failed.
 *
 * Stored entries win per key (pair and car records observed since the upgrade
 * reflect current reality); the legacy value fills everything else, with cars
 * bounded by `EV_CAR_LINK_MAX_TRACKED_CARS` (legacy entries dropped first). A
 * colliding pair record is taken from the store WHOLESALE — no per-field
 * sub-merge like calibration's per-(device, step) overlay — because vote
 * counts cannot be combined without double-counting: a plug edge spanning the
 * upgrade can be counted on both sides, so summing would inflate exactly the
 * affinity evidence the votes exist to accumulate, while calibration's step
 * EMAs are independent keyed observations with no such overlap.
 *
 * A car the store holds a pair for is the store's to answer for, stops or
 * none: the probe has voted on it since. A charge past a limit its stops
 * qualified clears them (`clearEvCarObservedStops`), and that takes a link,
 * which the probe only makes for a car it votes on (a coincidence, or a prior
 * from its votes). So every car a disproval cleared holds a pair, and absence
 * there cannot tell a cleared limit from "never stopped": refilling it would
 * qualify the disproven limit again. A car with no stored pair was never
 * linked, so it can neither have banked a stop nor lost one, and takes the
 * legacy stops.
 *
 * Sessions are deliberately NOT filled from the legacy side: the store's
 * absence cannot distinguish "never seen" from "cleared by an observed session
 * end since the upgrade", and re-injecting a cleared session re-arms the
 * wrong-resume risk `evCarLinkSessionResume.ts` documents (a car connected
 * elsewhere reports connected exactly like one connected here). Sessions are
 * lifecycle state, not the evidence this merge exists to preserve.
 */
export const withLegacyEvCarLinkUnder = (
    stored: EvCarLinkSnapshot,
    legacy: EvCarLinkSnapshot,
): EvCarLinkSnapshot => {
    const votedCarIds = new Set(Object.keys(stored.pairs).map((key) => parseEvCarLinkPairKey(key)?.carId));
    return {
        version: EV_CAR_LINK_VERSION,
        pairs: { ...legacy.pairs, ...stored.pairs },
        cars: Object.fromEntries([
            ...Object.entries(stored.cars),
            ...Object.entries(legacy.cars).filter(([carId]) => !(carId in stored.cars) && !votedCarIds.has(carId)),
        ].slice(0, EV_CAR_LINK_MAX_TRACKED_CARS)),
        sessions: { ...stored.sessions },
    };
};
