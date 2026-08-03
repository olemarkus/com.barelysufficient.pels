/**
 * Persisted-shape half of the EV car-to-charger link probe: version constant,
 * boundary normalisation, vote accumulation, self-stop sampling, and pruning.
 *
 * Split from `evCarLink.ts` (the correlation decisions) so each file stays under
 * the 500 LOC cap and so the persistence concerns are testable without the
 * matcher. The store wiring that debounces writes and rides out a transient
 * settings read lives in `evCarLinkStore.ts`.
 *
 * Everything here is pure. Unknown persisted shapes degrade to an empty snapshot
 * rather than throwing — the same defensive contract as
 * `normalizePowerCalibrationSnapshot`.
 */
import type {
    EvCarLinkAffinity,
    EvCarLinkSnapshot,
    EvCarLinkVersion,
    EvCarObservedStops,
} from '../../packages/contracts/src/evCarLink';

/**
 * Runtime version constant for {@link EvCarLinkSnapshot}. Defined here (not in
 * the contracts package) so Homey runtime code does not value-import from
 * `packages/contracts/src/**`, which is deploy-excluded.
 */
export const EV_CAR_LINK_VERSION: EvCarLinkVersion = 1;

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
    if (carId.length === 0 || chargerId.length === 0) return null;
    return { carId, chargerId };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFinitePositive = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
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
 * Returns a defensively-typed snapshot. Unknown shapes degrade to an empty
 * snapshot rather than throwing; partial pair/car records are dropped silently.
 * Use this whenever a snapshot crosses the persistence boundary.
 */
export const normalizeEvCarLinkSnapshot = (value: unknown, nowMs?: number): EvCarLinkSnapshot => {
    if (!isRecord(value)) return createEmptyEvCarLinkSnapshot();
    if (value.version !== EV_CAR_LINK_VERSION) return createEmptyEvCarLinkSnapshot();
    const pairsRaw = value.pairs;
    const carsRaw = value.cars;
    if (!isRecord(pairsRaw) || !isRecord(carsRaw)) return createEmptyEvCarLinkSnapshot();

    // Clamp any timestamp that sits in the future to the load-time clock. A
    // Homey clock jump mid-vote, or a corrupt persisted value, otherwise makes
    // `pruneEvCarLinkSnapshot` compute a NEGATIVE age that always satisfies the
    // retention check — so the record never expires and can keep qualifying as an
    // affinity prior forever. Clamping is conservative: the record simply starts
    // ageing from now instead of being trusted indefinitely.
    const clamp = (timestampMs: number): number => (
        nowMs !== undefined && timestampMs > nowMs ? nowMs : timestampMs
    );
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
        return [[chargerId, { carId, sinceMs: clamp(sinceMs) }] as const];
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

/** Records the session a charger is in, so a restart can offer to resume it. */
export const recordEvCarLinkSession = (params: {
    snapshot: EvCarLinkSnapshot;
    chargerId: string;
    carId: string;
    sinceMs: number;
}): EvCarLinkSnapshot => ({
    ...params.snapshot,
    sessions: {
        ...params.snapshot.sessions,
        [params.chargerId]: { carId: params.carId, sinceMs: params.sinceMs },
    },
});

/**
 * Forgets a charger's session. Called on every normal session end, so a
 * persisted session can only ever survive an outage — never an unplug PELS saw.
 */
export const clearEvCarLinkSession = (params: {
    snapshot: EvCarLinkSnapshot;
    chargerId: string;
}): EvCarLinkSnapshot => {
    const { [params.chargerId]: removed, ...rest } = params.snapshot.sessions ?? {};
    return removed === undefined ? params.snapshot : { ...params.snapshot, sessions: rest };
};

/**
 * Strict plausibility gate for the load path. A snapshot that merely parses is
 * not proof the settings read succeeded — an empty-but-well-formed value is
 * exactly what a transient read failure looks like. The store uses this to
 * decide whether it may skip its load-grace window.
 */
export const isStrictlyValidPersistedEvCarLink = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (value.version !== EV_CAR_LINK_VERSION) return false;
    const { pairs, cars } = value;
    if (!isRecord(pairs) || !isRecord(cars)) return false;
    const pairEntries = Object.entries(pairs);
    const carEntries = Object.entries(cars);
    if (pairEntries.length === 0 && carEntries.length === 0) return false;
    return pairEntries.every(([key, raw]) => parseEvCarLinkPairKey(key) !== null && normalizeAffinity(raw) !== null)
        && carEntries.every(([carId, raw]) => carId.length > 0 && isFullyValidObservedStops(raw));
};

/**
 * Stricter than `normalizeObservedStops`, which FILTERS invalid samples and
 * still succeeds on a partially-corrupt array. A mixed payload like
 * `[80, null]` would otherwise pass the plausibility gate, the store would skip
 * its load grace, and the next accepted vote would persist the lossy normalized
 * value straight over history that was still recoverable. Partial corruption is
 * corruption: require every raw sample to survive on its own.
 */
const isFullyValidObservedStops = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    const { stopSocPct } = value;
    if (!Array.isArray(stopSocPct) || !stopSocPct.every(isValidSocPct)) return false;
    return normalizeObservedStops(value) !== null;
};

/**
 * Add one coincidence vote to a pair. Votes only ever increase: an away session
 * carries no counter-evidence, so there is deliberately no decrement path.
 */
export const recordEvCarLinkVote = (params: {
    snapshot: EvCarLinkSnapshot;
    carId: string;
    chargerId: string;
    nowMs: number;
}): EvCarLinkSnapshot => {
    const { snapshot, carId, chargerId, nowMs } = params;
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
 * Record the state-of-charge at which a car stopped charging on its own.
 *
 * Out-of-range readings are dropped rather than clamped — a clamped 0 or 100
 * would pollute the cluster the caller is trying to read. A car not yet tracked
 * is only admitted while under `EV_CAR_LINK_MAX_TRACKED_CARS`; already-tracked
 * cars always accept samples so a full table cannot silently freeze one car's
 * history.
 */
export const recordEvCarSelfStopSoc = (params: {
    snapshot: EvCarLinkSnapshot;
    carId: string;
    socPct: number;
    nowMs: number;
}): EvCarLinkSnapshot => {
    const { snapshot, carId, socPct, nowMs } = params;
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
): EvCarObservedLimit | null => {
    const samples = snapshot.cars[carId]?.stopSocPct ?? [];
    if (samples.length < 2) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const medianPct = sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    return {
        medianPct: Math.round(medianPct * 10) / 10,
        spreadPct: Math.round((sorted[sorted.length - 1] - sorted[0]) * 10) / 10,
        sampleCount: sorted.length,
    };
};

/** Drop pair and car records untouched for longer than `maxAgeMs`. */
export const pruneEvCarLinkSnapshot = (params: {
    snapshot: EvCarLinkSnapshot;
    nowMs: number;
    maxAgeMs?: number;
}): EvCarLinkSnapshot => {
    const { snapshot, nowMs, maxAgeMs = EV_CAR_LINK_PRUNE_MAX_AGE_MS } = params;
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
        ...(snapshot.sessions ? { sessions: snapshot.sessions } : {}),
    };
};
