/**
 * Pure correlation domain for the EV car-to-charger link probe.
 *
 * PELS models the charger, never the car. A car has its own charge limit, its
 * own departure schedule, and its own smart-charging logic; when it stops for
 * one of those reasons the charger frequently still reports a live session. This
 * module resolves which car belongs to which charger, and classifies the moments
 * a linked car stops charging of its own accord.
 *
 * Observation-only: every function here is pure, and nothing it returns reaches
 * planning, admission, or actuation. The persisted-shape half lives in
 * `evCarLinkSnapshot.ts`; the SDK-facing half in `evCarLinkProducer.ts`.
 *
 * ## Why link on plug edges only
 *
 * PELS itself commands chargers on and off, so a charger's charging-state
 * transitions are frequently PELS-caused and correlate with nothing about the
 * car. Connect/disconnect is a physical event both devices observe
 * independently, which makes it the only self-correlation-free signal available.
 * Charging transitions are deliberately NOT used as link evidence.
 *
 * ## Capability contract
 *
 * Official Homey capabilities only. The car side reads `ev_charging_state` and
 * `measure_battery`; the charger side reads PELS's already-resolved
 * `evChargingState` plus measured power. No vendor/driver-specific capability id
 * and no `driverId` branching appears anywhere in this feature.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';

/**
 * A physical plug event. Both sides derive it from the same closed enum, so one
 * derivation serves the car (`ev_charging_state`) and the charger
 * (`evcharger_charging_state`) alike.
 */
export type EvLinkEdgeKind = 'connect' | 'disconnect';

export type EvLinkEdge = {
    deviceId: string;
    kind: EvLinkEdgeKind;
    atMs: number;
};

/** Coincidence window for pairing a car edge with a charger edge. */
export const EV_CAR_LINK_COINCIDENCE_WINDOW_MS = 90_000;

/** Charger draw at or below this reads as "not delivering" for self-stop detection. */
export const EV_CAR_LINK_IDLE_POWER_W = 200;

/** How long the car must sit not-charging against a live charger before it counts. */
export const EV_CAR_LINK_SELF_STOP_MIN_MS = 120_000;

/** Votes a pair needs before the affinity prior may break a tie on its own. */
export const EV_CAR_LINK_MIN_PRIOR_VOTES = 2;

/** Bound on retained edges per side — see the RSS note in `notes/ev-car-link/README.md`. */
export const EV_CAR_LINK_MAX_EDGES_PER_SIDE = 20;

const CONNECTED_STATES: ReadonlySet<EvChargingState> = new Set<EvChargingState>([
    'plugged_in',
    'plugged_in_charging',
    'plugged_in_paused',
    'plugged_in_discharging',
]);

const isConnectedState = (state: EvChargingState | undefined): boolean => (
    state !== undefined && CONNECTED_STATES.has(state)
);

/**
 * Resolve a plug edge from a state transition.
 *
 * An absent `previous` yields `null` on purpose: the first observation after a
 * boot or a cold device read is not a physical plug event, and treating it as
 * one would manufacture a link vote at every restart. The cost is that the first
 * session after boot contributes no connect edge; its disconnect edge still
 * counts.
 */
export const resolveEvLinkEdge = (
    previous: EvChargingState | undefined,
    next: EvChargingState | undefined,
): EvLinkEdgeKind | null => {
    if (previous === undefined || next === undefined) return null;
    if (previous === next) return null;
    const wasConnected = isConnectedState(previous);
    const isConnected = isConnectedState(next);
    if (!wasConnected && isConnected) return 'connect';
    if (wasConnected && !isConnected) return 'disconnect';
    return null;
};

/**
 * Append an edge to a bounded ring, dropping the oldest when full. Returns a new
 * array — callers hold the ring immutably.
 */
export const appendEvLinkEdge = (edges: readonly EvLinkEdge[], edge: EvLinkEdge): EvLinkEdge[] => {
    const next = [...edges, edge];
    return next.length > EV_CAR_LINK_MAX_EDGES_PER_SIDE
        ? next.slice(next.length - EV_CAR_LINK_MAX_EDGES_PER_SIDE)
        : next;
};

/** Drop edges older than the coincidence window; they can no longer pair. */
export const pruneExpiredEvLinkEdges = (
    edges: readonly EvLinkEdge[],
    nowMs: number,
    windowMs: number = EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
): EvLinkEdge[] => edges.filter((edge) => nowMs - edge.atMs <= windowMs);

export type EvLinkCoincidence = {
    carId: string;
    chargerId: string;
    kind: EvLinkEdgeKind;
    deltaMs: number;
    /** Charger-edge timestamp — identifies WHICH session this pairing belongs to. */
    atMs: number;
};

export type EvLinkAmbiguity = {
    chargerId: string;
    carIds: string[];
    kind: EvLinkEdgeKind;
    /** Charger-edge timestamp, for the same per-session identity reason. */
    atMs: number;
};

export type EvLinkMatchResult = {
    /** Exactly-one-car-to-one-charger pairings; each is worth a vote. */
    coincidences: EvLinkCoincidence[];
    /** A charger edge that several cars could explain — deliberately no vote. */
    ambiguities: EvLinkAmbiguity[];
    /** Car edges that no charger edge explains — a session somewhere else. */
    unmatchedCarEdges: EvLinkEdge[];
};

/**
 * Pair car edges against charger edges of the same kind inside the coincidence
 * window.
 *
 * Three outcomes, and the distinction between them is the whole point:
 *   - exactly one car matches a charger edge → a coincidence worth voting on;
 *   - two or more cars match → ambiguous, no vote. A home with two cars must not
 *     accumulate a confident-but-wrong link from simultaneous plug-ins;
 *   - a car edge matches no charger edge → the car connected somewhere else.
 *     Reported so the caller can log it, but it carries NO vote in either
 *     direction: an away session is silent evidence, not counter-evidence.
 */
export const matchCoincidentEdges = (params: {
    carEdges: readonly EvLinkEdge[];
    chargerEdges: readonly EvLinkEdge[];
    windowMs?: number;
}): EvLinkMatchResult => {
    const { carEdges, chargerEdges, windowMs = EV_CAR_LINK_COINCIDENCE_WINDOW_MS } = params;
    const coincidences: EvLinkCoincidence[] = [];
    const ambiguities: EvLinkAmbiguity[] = [];
    const matchedCarKeys = new Set<string>();

    for (const chargerEdge of chargerEdges) {
        const candidates = carEdges.filter((carEdge) => (
            carEdge.kind === chargerEdge.kind
            && Math.abs(carEdge.atMs - chargerEdge.atMs) <= windowMs
        ));
        if (candidates.length === 0) continue;
        for (const candidate of candidates) {
            matchedCarKeys.add(buildEdgeKey(candidate));
        }
        if (candidates.length > 1) {
            ambiguities.push({
                chargerId: chargerEdge.deviceId,
                carIds: candidates.map((candidate) => candidate.deviceId),
                kind: chargerEdge.kind,
                atMs: chargerEdge.atMs,
            });
            continue;
        }
        const [carEdge] = candidates;
        coincidences.push({
            carId: carEdge.deviceId,
            chargerId: chargerEdge.deviceId,
            kind: chargerEdge.kind,
            deltaMs: carEdge.atMs - chargerEdge.atMs,
            atMs: chargerEdge.atMs,
        });
    }

    return {
        coincidences,
        ambiguities,
        unmatchedCarEdges: carEdges.filter((edge) => !matchedCarKeys.has(buildEdgeKey(edge))),
    };
};

const buildEdgeKey = (edge: EvLinkEdge): string => `${edge.deviceId}|${edge.kind}|${edge.atMs}`;

export type EvLinkResolution = {
    carId: string;
    source: 'coincidence' | 'affinity_prior';
    votes: number;
};

/**
 * Decide which car a charger is serving.
 *
 * A live coincidence always wins — it is same-session evidence. The persisted
 * affinity prior only breaks a tie, and only when exactly one candidate has
 * cleared `EV_CAR_LINK_MIN_PRIOR_VOTES` while every other candidate has none. A
 * prior that merely leads is not enough: the point of the threshold is that a
 * second car in the household must never inherit the first car's history.
 */
export const resolveLinkForCharger = (params: {
    coincidentCarId?: string;
    candidateCarIds: readonly string[];
    votesFor: (carId: string) => number;
}): EvLinkResolution | null => {
    const { coincidentCarId, candidateCarIds, votesFor } = params;
    if (coincidentCarId !== undefined) {
        return { carId: coincidentCarId, source: 'coincidence', votes: votesFor(coincidentCarId) };
    }
    const qualified = candidateCarIds.filter((carId) => votesFor(carId) >= EV_CAR_LINK_MIN_PRIOR_VOTES);
    if (qualified.length !== 1) return null;
    const [carId] = qualified;
    const contested = candidateCarIds.some((other) => other !== carId && votesFor(other) > 0);
    if (contested) return null;
    return { carId, source: 'affinity_prior', votes: votesFor(carId) };
};

/**
 * Why a linked car is not drawing power while its charger is live.
 *
 * `car_schedule_hold` is the car's own schedule or smart-charging holding the
 * session (`plugged_in_paused`). `car_not_charging` is deliberately vague:
 * `plugged_in` collapses "finished at the car's charge limit", "idle", and
 * "charging fault" into one value, and no official capability separates them.
 * Naming it `target_reached` would assert something the data cannot support —
 * the `stopSocPct` cluster is what eventually distinguishes them.
 */
export type EvCarSelfStopReason = 'car_not_charging' | 'car_schedule_hold';

/**
 * Classify a car that has stopped charging for its own reasons.
 *
 * Requires all of: the car reports connected-but-not-charging, the charger still
 * believes it is delivering, and measured draw is at or below the idle
 * threshold. Returns `null` whenever any condition fails, including a non-finite
 * power reading — an unreadable measurement is not evidence of idleness.
 *
 * This is the instantaneous verdict. The caller owns the dwell requirement
 * (`EV_CAR_LINK_SELF_STOP_MIN_MS`), because only the caller knows how long the
 * condition has held continuously; a charger momentarily reading zero mid-ramp
 * satisfies this predicate but must not count as a self-stop.
 */
export const classifyEvCarSelfStop = (params: {
    carState: EvChargingState | undefined;
    chargerState: EvChargingState | undefined;
    chargerCommandedOn: boolean;
    chargerPowerW: number | null;
}): EvCarSelfStopReason | null => {
    const { carState, chargerState, chargerCommandedOn, chargerPowerW } = params;
    if (chargerPowerW === null || !Number.isFinite(chargerPowerW)) return null;
    if (chargerPowerW > EV_CAR_LINK_IDLE_POWER_W) return null;
    const chargerBelievesLive = chargerState === 'plugged_in_charging' || chargerCommandedOn;
    if (!chargerBelievesLive) return null;
    if (carState === 'plugged_in_paused') return 'car_schedule_hold';
    if (carState === 'plugged_in') return 'car_not_charging';
    return null;
};

/**
 * Whether a car's state-of-charge is climbing while the charger it is linked to
 * delivers nothing — proof the car is charging somewhere else, independent of
 * any plug-edge evidence.
 */
export const isChargingElsewhere = (params: {
    previousSocPct: number | null;
    currentSocPct: number | null;
    chargerPowerW: number | null;
}): boolean => {
    const { previousSocPct, currentSocPct, chargerPowerW } = params;
    if (previousSocPct === null || currentSocPct === null) return false;
    if (chargerPowerW === null || !Number.isFinite(chargerPowerW)) return false;
    if (chargerPowerW > EV_CAR_LINK_IDLE_POWER_W) return false;
    return currentSocPct > previousSocPct;
};
