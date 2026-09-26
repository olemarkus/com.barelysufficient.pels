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
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';

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

/**
 * Age at which an unmatched car edge becomes a settled "charged elsewhere"
 * verdict. Two windows, not one: a charger edge that could still explain a car
 * edge at time T lies within [T-W, T+W], and the latest of those does not itself
 * settle until (T+W)+W. Reporting at one window would call an away session on a
 * pair that links moments later purely from event-ordering jitter.
 */
export const EV_CAR_LINK_AWAY_VERDICT_MS = EV_CAR_LINK_COINCIDENCE_WINDOW_MS * 2;

/** Bound on retained edges per side — see the RSS note in `notes/ev-car-link/README.md`. */
export const EV_CAR_LINK_MAX_EDGES_PER_SIDE = 20;

/**
 * Resolve a plug edge from a state transition.
 *
 * Both states are REQUIRED. A device with no readable plug state is never
 * tracked, so "unknown" cannot reach this function; and the caller does not call
 * it at all when there is no previous observation, because a first reading after
 * a boot is not a physical plug event and treating it as one would manufacture a
 * link vote at every restart. The cost is that the first session after boot
 * contributes no connect edge; its disconnect edge still counts.
 */
export const resolveEvLinkEdge = (
    previous: EvChargingState,
    next: EvChargingState,
): EvLinkEdgeKind | null => {
    if (previous === next) return null;
    const wasConnected = isEvPlugStateConnected(previous);
    const isConnected = isEvPlugStateConnected(next);
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
    /**
     * Charger edges no car edge could explain at all. Distinct from an AMBIGUOUS
     * edge, which has live candidates the matcher refused to choose between:
     * only a genuinely candidate-free edge may fall back to the persisted prior,
     * or the fallback would quietly overturn the ambiguity rule.
     */
    unmatchedChargerEdges: EvLinkEdge[];
};

/**
 * Pair car edges against charger edges of the same kind inside the coincidence
 * window.
 *
 * Three outcomes, and the distinction between them is the whole point:
 *   - exactly one car matches a charger edge, and that car matches no OTHER
 *     charger → a coincidence worth voting on;
 *   - two or more cars match a charger, OR the single matching car could equally
 *     be explained by another charger → ambiguous, no vote. One physical car
 *     cannot be on two chargers, so a car edge that fits two of them is evidence
 *     for neither; voting for both would corrupt the affinity map in exactly the
 *     multi-charger home the probe has to survive;
 *   - a car edge matches no charger edge → the car connected somewhere else.
 *     Reported so the caller can log it, but it carries NO vote in either
 *     direction: an away session is silent evidence, not counter-evidence.
 *
 * "Car" and "charger" there mean DEVICES, not edges. A plug that bounces —
 * connected, unplugged, connected again inside one window — gives one charger
 * several edges of the same kind, and each of them fits the same car edge. That
 * is one charger, not two competing for the car, and counting it as a contest
 * marked every edge ambiguous: prod 2026-09-12, a one-car home whose charger was
 * plugged and unplugged several times in quick succession never linked, so the
 * charger had no battery level and the night's smart task could not plan. The
 * same holds on the car side: several edges from one car are one candidate.
 *
 * A bounce is also one physical event, so it earns one decision, not one per
 * bounce. The burst is every edge of one charger joined through shared car
 * edges; only its latest edge decides, because that is the state the plug came
 * to rest in, and it decides on the WHOLE burst's candidates. A rival car that
 * only an earlier edge of the burst could explain is still a rival: judging the
 * latest edge on its own candidates would link a car the burst had already
 * refused. Earlier edges still count as explained, so they are never reported
 * as away sessions.
 */
export const matchCoincidentEdges = (params: {
    carEdges: readonly EvLinkEdge[];
    /** ALL retained charger edges — settled or not. See the contention note. */
    chargerEdges: readonly EvLinkEdge[];
    nowMs: number;
    windowMs?: number;
    settleMs?: number;
}): EvLinkMatchResult => {
    const {
        carEdges,
        chargerEdges,
        nowMs,
        windowMs = EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
        settleMs = EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
    } = params;
    const isSettled = (edge: EvLinkEdge): boolean => nowMs - edge.atMs >= settleMs;
    const scored = chargerEdges
        .map((chargerEdge) => ({
            chargerEdge,
            candidates: carEdges.filter((carEdge) => (
                carEdge.kind === chargerEdge.kind
                && Math.abs(carEdge.atMs - chargerEdge.atMs) <= windowMs
            )),
        }));
    const withCandidates = scored.flatMap(({ chargerEdge, candidates }): ScoredChargerEdge[] => (
        hasEdges(candidates) ? [{ chargerEdge, candidates }] : []
    ));

    const coincidences: EvLinkCoincidence[] = [];
    const ambiguities: EvLinkAmbiguity[] = [];

    for (const entry of withCandidates) {
        const { chargerEdge } = entry;
        // Decide only once this edge has settled; contention below still counts
        // edges that have not.
        if (!isSettled(chargerEdge)) continue;
        const burst = resolveChargerEdgeBurst(entry, withCandidates);
        // An earlier edge of a bouncing plug; the burst's resting edge decides.
        if (burst.restingEdge !== chargerEdge) continue;
        const carIds = distinctDeviceIds(burst.candidates);
        if (carIds.length > 1 || isContestedByAnotherCharger(burst, withCandidates)) {
            ambiguities.push({
                chargerId: chargerEdge.deviceId,
                carIds,
                kind: chargerEdge.kind,
                atMs: chargerEdge.atMs,
            });
            continue;
        }
        // One car, possibly with several edges. The LATEST one stands for it:
        // the caller waits one window past the car edge it is handed before
        // finalising, and only the latest guarantees every charger that could
        // contest any of these edges has been ingested by then.
        const carEdge = latestEdge(burst.candidates);
        coincidences.push({
            carId: carEdge.deviceId,
            chargerId: chargerEdge.deviceId,
            kind: chargerEdge.kind,
            deltaMs: carEdge.atMs - chargerEdge.atMs,
            atMs: chargerEdge.atMs,
        });
    }

    // Every car edge some charger edge fits, whatever was decided about it:
    // ambiguous and superseded edges are explained, just not attributable.
    const matchedCarKeys = new Set(withCandidates.flatMap((entry) => entry.candidates.map(buildEdgeKey)));
    return {
        coincidences,
        ambiguities,
        unmatchedCarEdges: carEdges.filter((edge) => !matchedCarKeys.has(buildEdgeKey(edge))),
        unmatchedChargerEdges: scored
            .filter((entry) => entry.candidates.length === 0 && isSettled(entry.chargerEdge))
            .map((entry) => entry.chargerEdge),
    };
};

const buildEdgeKey = (edge: EvLinkEdge): string => `${edge.deviceId}|${edge.kind}|${edge.atMs}`;

/** At least one edge. A charger edge only enters matching with a car edge that fits it. */
type EvLinkEdges = readonly [EvLinkEdge, ...EvLinkEdge[]];

const hasEdges = (edges: readonly EvLinkEdge[]): edges is EvLinkEdges => edges.length > 0;

/** A charger edge together with the car edges that fit it inside the window. */
type ScoredChargerEdge = {
    chargerEdge: EvLinkEdge;
    candidates: EvLinkEdges;
};

/**
 * One charger's edges joined through shared car edges: a bouncing plug, or
 * just a single edge. See "DEVICES, not edges" on `matchCoincidentEdges`.
 */
type ChargerEdgeBurst = {
    /** The burst's latest charger edge, where the plug came to rest. Only it decides. */
    restingEdge: EvLinkEdge;
    /** Every car edge any edge of the burst fits. */
    candidates: EvLinkEdges;
};

/**
 * The burst `entry` belongs to: every edge of the same charger reachable from it
 * through shared car edges, transitively, because a plug bouncing for longer
 * than one window chains edges that share no car edge directly. Candidates
 * always share their charger edge's kind, so a shared car edge implies the same
 * kind too.
 */
const resolveChargerEdgeBurst = (
    entry: ScoredChargerEdge,
    scored: readonly ScoredChargerEdge[],
): ChargerEdgeBurst => {
    const members: ScoredChargerEdge[] = [entry];
    let grew = true;
    while (grew) {
        grew = false;
        for (const other of scored) {
            if (members.includes(other) || !members.some((member) => sharesCarEdge(member, other))) continue;
            members.push(other);
            grew = true;
        }
    }
    const candidates: [EvLinkEdge, ...EvLinkEdge[]] = [...entry.candidates];
    for (const member of members) {
        if (member !== entry) addEdges(candidates, member.candidates);
    }
    return { restingEdge: latestEdge(chargerEdgesOf(members, entry)), candidates };
};

const chargerEdgesOf = (members: readonly ScoredChargerEdge[], entry: ScoredChargerEdge): EvLinkEdges => (
    [entry.chargerEdge, ...members.map((member) => member.chargerEdge)]
);

const addEdges = (target: EvLinkEdge[], edges: EvLinkEdges): void => {
    for (const edge of edges) target.push(edge);
};

const sharesCarEdge = (a: ScoredChargerEdge, b: ScoredChargerEdge): boolean => (
    a.chargerEdge.deviceId === b.chargerEdge.deviceId
    && a.candidates.some((candidate) => b.candidates.includes(candidate))
);

/**
 * Whether any car edge of the burst also fits an edge of a DIFFERENT charger,
 * counted over all retained edges rather than only the settled ones. A charger
 * that connects slightly later is still competition: finalising a vote the
 * moment the first charger settles would hand out a persisted vote and an
 * active link that the later edge's ambiguity can no longer retract.
 */
const isContestedByAnotherCharger = (
    burst: ChargerEdgeBurst,
    scored: readonly ScoredChargerEdge[],
): boolean => scored.some((other) => (
    other.chargerEdge.deviceId !== burst.restingEdge.deviceId
    && other.candidates.some((candidate) => burst.candidates.includes(candidate))
));

const distinctDeviceIds = (edges: EvLinkEdges): string[] => (
    Array.from(new Set(edges.map((edge) => edge.deviceId)))
);

const latestEdge = (edges: EvLinkEdges): EvLinkEdge => {
    const [first] = edges;
    let latest = first;
    for (const edge of edges) {
        if (edge.atMs > latest.atMs) latest = edge;
    }
    return latest;
};

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
    const [carId, ...alsoQualified] = qualified;
    if (carId === undefined || alsoQualified.length > 0) return null;
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
 * How far before the charger's last delivery reading a PELS stop command still
 * explains the stop. A write can take seconds to land (an Easee takes up to ~8 s to accept
 * one) and the charger reports the pause seconds after that, so the command
 * precedes the end of delivery; three minutes covers both with room to spare.
 */
export const EV_CAR_LINK_PELS_STOP_LOOKBACK_MS = 180_000;

/**
 * One pass's view of a linked charger and its car, as far as a stop goes.
 *
 * `lastDeliveryReadingAtMs` is when the charger's last above-idle reading was
 * TAKEN, and is set only if that delivery belongs to this session (the watcher
 * decides that from the pass it was seen on). The reading's own time, not the
 * pass: with a delayed power report (a 5-minute poll with the live feed down, or
 * power reported by an owner's Flow) passes keep seeing the old draw after PELS
 * has paused the charger, and anchoring on the pass would put the pause before
 * the window that is meant to catch it. `lastStopCommandAtMs` is when PELS last
 * told the charger to stop. Both live in memory, so a restart forgets them and
 * no stop counts until delivery is seen again.
 */
export type EvCarStopObservation = {
    carState: EvChargingState;
    chargerState: EvChargingState;
    chargerPowerW: number;
    /** The charger's observed switch, `binaryControl.on`. */
    chargerSwitchOn: boolean;
    lastDeliveryReadingAtMs: number | undefined;
    lastStopCommandAtMs: number | undefined;
};

/**
 * Classify a car that has stopped charging for its own reasons.
 *
 * The stop is the car's only when all of these hold:
 * - the charger delivered in this session and now draws at most the idle
 *   threshold — a charger that never delivered did not stop, it never started
 *   (a charger held off by PELS, or an Easee waiting out its resume hold-off);
 * - PELS did not tell it to stop, from shortly before that delivery was read
 *   until now — a PELS pause reads exactly like a car stop from the car's side,
 *   which reports both as connected-but-not-charging;
 * - nobody else switched it off: a charger that still reads connected but whose
 *   switch reads off was stopped from outside (an owner's "car at 80 % → charger
 *   off" Flow would otherwise bank 80 % every session). A charger that reads
 *   `plugged_out` is exempt, because an Easee ends the session at the car's
 *   limit exactly that way, switch and plug state together;
 * - the charger is not holding the session paused (`plugged_in_paused`), which
 *   is where PELS's own 0 A pause and a charger-app schedule both land;
 * - the car reports connected-but-not-charging.
 *
 * Every input is REQUIRED and already resolved. An unreadable power measurement
 * is not evidence of idleness, so the caller must not call this at all when it
 * has none.
 *
 * The PELS-stop test runs from shortly before the delivery reading up to now,
 * so the verdict stays sound however late a pass first sees the stop: a pause
 * PELS sent in that gap still rules it out, and a car that is not charging
 * still holds the charge it stopped at.
 *
 * This is the instantaneous verdict. The caller owns the dwell requirement
 * (`EV_CAR_LINK_SELF_STOP_MIN_MS`), because only the caller knows when the
 * episode began; a charger momentarily reading zero mid-ramp satisfies this
 * predicate but must not count as a self-stop.
 */
export const classifyEvCarSelfStop = (observation: EvCarStopObservation): EvCarSelfStopReason | null => {
    const {
        carState, chargerState, chargerPowerW, chargerSwitchOn, lastDeliveryReadingAtMs, lastStopCommandAtMs,
    } = observation;
    if (chargerPowerW > EV_CAR_LINK_IDLE_POWER_W) return null;
    if (lastDeliveryReadingAtMs === undefined) return null;
    const stoppedByPels = lastStopCommandAtMs !== undefined
        && lastStopCommandAtMs >= lastDeliveryReadingAtMs - EV_CAR_LINK_PELS_STOP_LOOKBACK_MS;
    if (stoppedByPels) return null;
    if (!chargerSwitchOn && chargerState !== 'plugged_out') return null;
    if (chargerState === 'plugged_in_paused') return null;
    if (carState === 'plugged_in_paused') return 'car_schedule_hold';
    if (carState === 'plugged_in') return 'car_not_charging';
    return null;
};

/**
 * Whether a car's charge climbed across an interval during which the linked
 * charger delivered nothing — evidence the car is plugged in somewhere else,
 * independent of any plug-edge evidence.
 *
 * `idleSinceMs` is what makes this sound: a single current idle reading does NOT
 * prove the rise happened while idle. PELS pausing a charger just after the
 * charge went up would otherwise be misread as an away session. The caller
 * supplies when the charger last started reading idle, and the rise only counts
 * when the newer charge reading was observed after that point.
 *
 * All inputs are required and resolved; the caller skips the check when it lacks
 * any of them.
 */
export const isChargingElsewhere = (params: {
    previousSocPct: number;
    currentSocPct: number;
    currentSocAtMs: number;
    chargerPowerW: number;
    chargerIdleSinceMs: number;
}): boolean => {
    const {
        previousSocPct, currentSocPct, currentSocAtMs, chargerPowerW, chargerIdleSinceMs,
    } = params;
    if (chargerPowerW > EV_CAR_LINK_IDLE_POWER_W) return false;
    if (currentSocAtMs < chargerIdleSinceMs) return false;
    return currentSocPct > previousSocPct;
};
