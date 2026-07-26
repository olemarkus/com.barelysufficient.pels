/**
 * Read-only EV car-to-charger link producer.
 *
 * Mirrors `BatteryStateProducer` / `SolarProductionProducer`: consulted from the
 * same two seams (a SUCCESSFUL full device fetch, plus the realtime
 * `device.update` path), holds a small bounded state, and surfaces everything it
 * learns as structured events. Nothing it produces is read by planning,
 * admission, or actuation — this is a probe answering "can PELS pick this up,
 * and how well?" before any behaviour depends on the answer.
 *
 * Class `car` devices are invisible to the rest of PELS (they are not in
 * `SUPPORTED_DEVICE_CLASSES`), so this producer reads them straight off the raw
 * device payload the fetch and the live feed already carry. No new subscription
 * and no new network read is introduced.
 *
 * ## Capability contract
 *
 * Official Homey capabilities only: `ev_charging_state` and `measure_battery` on
 * the car. The charger side arrives pre-resolved as {@link EvCarLinkChargerView},
 * narrowed by the transport wiring that owns the observed-cluster guards — this
 * producer never touches a raw charger capability, and never branches on
 * `driverId`.
 *
 * Correlation rules and their rationale live in `evCarLink.ts`; the design of
 * record is `notes/ev-car-link/README.md`.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyDeviceLike } from '../utils/types';
import { isEvChargingState } from './managerControl';
import { normalizeStateOfChargePercent } from './transport/stateOfCharge';
import {
    EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
    EV_CAR_LINK_SELF_STOP_MIN_MS,
    type EvCarSelfStopReason,
    type EvLinkAmbiguity,
    type EvLinkCoincidence,
    type EvLinkEdge,
    appendEvLinkEdge,
    classifyEvCarSelfStop,
    isChargingElsewhere,
    matchCoincidentEdges,
    pruneExpiredEvLinkEdges,
    resolveEvLinkEdge,
    resolveLinkForCharger,
} from './evCarLink';
import {
    getEvCarLinkVotes,
    recordEvCarLinkVote,
    recordEvCarSelfStopSoc,
    summarizeEvCarObservedLimit,
} from './evCarLinkSnapshot';

/** Unmatched edges are retained twice the window so "no match" is a settled verdict. */
const EDGE_RETENTION_MS = EV_CAR_LINK_COINCIDENCE_WINDOW_MS * 2;

/** Bound on the one-shot report-dedupe ring (see `claimReportKey`). */
const MAX_REPORTED_KEYS = 200;

/**
 * Charger state as the transport wiring resolves it. Flat, already-narrowed
 * values: the observed-cluster guards (`isEvObserved`, `hasObservedStateOfCharge`,
 * `hasObservedMeasuredPower`) are applied by the producer seam that builds this,
 * so nothing downstream re-branches on provenance.
 */
export type EvCarLinkChargerView = {
    id: string;
    name: string;
    evChargingState: EvChargingState | undefined;
    /** Measured draw in watts; `null` when there is no trusted reading. */
    measuredPowerW: number | null;
    /**
     * The charger's OBSERVED binary control state — not what PELS commanded.
     * Kept observed-only on purpose: `lib/device/AGENTS.md` treats collapsing
     * commanded into observed as the bug this layer exists to prevent. It is
     * used here only to widen "the charger believes it is delivering" beyond a
     * literal `plugged_in_charging`, never to assert PELS asked for anything.
     */
    controlOn: boolean;
    /** State-of-charge already on the charger snapshot (the existing flow card). */
    reportedSocPct: number | null;
};

export type EvCarLinkEvent =
    | {
        component: 'devices'; event: 'ev_car_link_candidate';
        carId: string; carName: string; chargerId: string; chargerName: string;
        kind: string; deltaMs: number; votes: number;
    }
    | {
        component: 'devices'; event: 'ev_car_link_resolved';
        carId: string; carName: string; chargerId: string; chargerName: string;
        votes: number; source: string;
    }
    | {
        component: 'devices'; event: 'ev_car_link_ambiguous';
        chargerId: string; chargerName: string; carIds: string[]; kind: string;
    }
    | {
        component: 'devices'; event: 'ev_car_session_elsewhere';
        carId: string; carName: string; reason: string;
    }
    | {
        component: 'devices'; event: 'ev_car_self_stopped';
        carId: string; carName: string; chargerId: string; chargerName: string;
        subReason: EvCarSelfStopReason; stoppedAtSocPct: number | null;
        chargerPowerW: number | null; heldForMs: number;
        observedLimitPct: number | null; observedLimitSpreadPct: number | null;
        observedLimitSamples: number;
    }
    | {
        component: 'devices'; event: 'ev_car_link_soc_shadow';
        carId: string; carName: string; chargerId: string; chargerName: string;
        carSocPct: number; reportedSocPct: number | null; deltaPct: number | null;
        wouldAdopt: boolean;
    };

export type EvCarLinkEventEmitter = (payload: EvCarLinkEvent) => void;

type CarObservation = {
    name: string;
    state: EvChargingState | undefined;
    socPct: number | null;
};

type ActiveLink = { carId: string; source: string };

export type EvCarLinkProducerDeps = {
    emit: EvCarLinkEventEmitter;
    /** Committed charger views; read lazily so the producer never holds snapshots. */
    getChargers: () => readonly EvCarLinkChargerView[];
    getSnapshot: () => EvCarLinkSnapshot;
    setSnapshot: (snapshot: EvCarLinkSnapshot) => void;
};

/**
 * Validate a raw device payload as a car observation. Official capabilities
 * only; anything malformed resolves to `undefined` rather than a fabricated
 * value, so junk never becomes a plug edge or a charge sample.
 */
const readCarDevice = (device: HomeyDeviceLike): {
    deviceId: string;
    name: string;
    state: EvChargingState | undefined;
    socPct: number | null;
} | null => {
    if (typeof device.class !== 'string' || device.class.trim().toLowerCase() !== 'car') return null;
    const deviceId = device.id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
    const rawState = device.capabilitiesObj?.ev_charging_state?.value;
    return {
        deviceId,
        name: typeof device.name === 'string' ? device.name : deviceId,
        state: isEvChargingState(rawState) ? rawState : undefined,
        socPct: normalizeStateOfChargePercent(device.capabilitiesObj?.measure_battery?.value) ?? null,
    };
};

export class EvCarLinkProducer {
    private carEdges: readonly EvLinkEdge[] = [];
    private chargerEdges: readonly EvLinkEdge[] = [];
    private readonly cars = new Map<string, CarObservation>();
    private readonly lastChargerState = new Map<string, EvChargingState | undefined>();
    private readonly activeLinks = new Map<string, ActiveLink>();
    private readonly selfStopSinceMs = new Map<string, number>();
    private readonly selfStopReported = new Set<string>();
    /** Charge readings awaiting link resolution; see `flushPendingSocShadows`. */
    private readonly pendingSocShadows = new Map<string, { previousSocPct: number | null; socPct: number }>();
    /**
     * One-shot dedupe for events derived from retained edges, which are re-matched
     * on every correlation pass. Bounded by `MAX_REPORTED_KEYS`: edges expire long
     * before the cap, so eviction only ever discards keys whose edges are gone —
     * it cannot resurrect a duplicate for a live edge.
     */
    private reportedKeys: string[] = [];
    private readonly reportedKeySet = new Set<string>();

    constructor(private readonly deps: EvCarLinkProducerDeps) {}

    /** Returns `false` when this key was already reported; records it otherwise. */
    private claimReportKey(key: string): boolean {
        if (this.reportedKeySet.has(key)) return false;
        this.reportedKeySet.add(key);
        this.reportedKeys = [...this.reportedKeys, key];
        if (this.reportedKeys.length > MAX_REPORTED_KEYS) {
            const [evicted, ...rest] = this.reportedKeys;
            this.reportedKeys = rest;
            this.reportedKeySet.delete(evicted);
        }
        return true;
    }

    /** Whether `deviceId` is a currently-tracked car. */
    isCarDevice(deviceId: string): boolean {
        return this.cars.has(deviceId);
    }

    /**
     * Ids of the cars seen so far. Consumed by the targeted refresh, which
     * otherwise re-reads only devices that survived parse — and a car never does.
     * Without this the probe would depend entirely on the live feed, and a car
     * would go unobserved for as long as that feed was down.
     */
    getObservedCarDeviceIds(): string[] {
        return [...this.cars.keys()];
    }

    /**
     * Realtime `device.update` seam, mirroring `noteBatteryDevice` /
     * `noteSolarDevice`. Ingests the payload when it is a car, and correlates on
     * EVERY update regardless of class.
     *
     * Correlating only on car updates would stamp charger edges with the time the
     * next car update happened to arrive rather than when the charger actually
     * moved — enough drift to push a genuinely coincident pair outside the window.
     * The charger's own update is what makes its edge timely.
     *
     * Cheap by construction: with no car tracked there is nothing to correlate
     * against, so the whole pass is skipped. That is the common case for every
     * user who has no car app installed.
     */
    noteDeviceUpdate(device: HomeyDeviceLike, nowMs: number): void {
        this.ingestCar(device, nowMs);
        if (this.cars.size === 0) return;
        this.correlate(nowMs);
    }

    /**
     * Consult a SUCCESSFULLY fetched device list. `fullRefresh` is accepted for
     * symmetry with the sibling producers; car membership is additive either way
     * because a car that stops appearing simply stops producing edges — there is
     * no downstream consumer whose behaviour a stale entry could change.
     */
    observe(devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean; nowMs: number }): void {
        void options.fullRefresh;
        for (const device of devices) {
            this.ingestCar(device, options.nowMs);
        }
        this.correlate(options.nowMs);
    }

    /** Read a car device's official capabilities; returns whether it is a car at all. */
    private ingestCar(device: HomeyDeviceLike, nowMs: number): boolean {
        const reading = readCarDevice(device);
        if (!reading) return false;
        const { deviceId, name, state, socPct } = reading;

        const previous = this.cars.get(deviceId);
        this.cars.set(deviceId, { name, state, socPct });

        const edgeKind = resolveEvLinkEdge(previous?.state, state);
        if (edgeKind !== null) {
            this.carEdges = appendEvLinkEdge(this.carEdges, { deviceId, kind: edgeKind, atMs: nowMs });
        }
        // Queue rather than emit: the link for this car may be resolved later in
        // the very same pass (`correlate` runs after ingest), and a shadow emitted
        // here would be silently dropped for want of an active link.
        if (socPct !== null && previous?.socPct !== socPct) {
            this.pendingSocShadows.set(deviceId, { previousSocPct: previous?.socPct ?? null, socPct });
        }
        return true;
    }

    /**
     * Sample charger views, diff them into edges, then run every correlation lane.
     *
     * A charger edge is only matched once it has SETTLED — one full coincidence
     * window has elapsed since it happened. Deciding eagerly would vote for the
     * first car to plug in and be unable to retract that vote when a second car
     * connects moments later at the same charger, which is exactly the two-car
     * household this probe has to survive. The cost is that a link resolves ~90 s
     * after plug-in; nothing downstream is time-critical (the self-stop watcher
     * needs a longer dwell than that anyway).
     */
    private correlate(nowMs: number): void {
        const chargers = this.deps.getChargers();
        this.ingestChargerEdges(chargers, nowMs);

        const settledChargerEdges = this.chargerEdges.filter((edge) => (
            nowMs - edge.atMs >= EV_CAR_LINK_COINCIDENCE_WINDOW_MS
        ));
        const match = matchCoincidentEdges({ carEdges: this.carEdges, chargerEdges: settledChargerEdges });
        this.applyCoincidences(match.coincidences, chargers, nowMs);
        this.reportAmbiguities(match.ambiguities, chargers);
        // Only edges the matcher could not explain, and only after their window
        // has closed. Matching runs BEFORE the prune below, so an edge always gets
        // at least one matched pass at every age up to retention — there is no
        // separate "about to expire" sweep, and adding one would report
        // successfully-linked edges as away sessions once they aged out.
        this.reportSessionsElsewhere(match.unmatchedCarEdges, nowMs);
        this.carEdges = pruneExpiredEvLinkEdges(this.carEdges, nowMs, EDGE_RETENTION_MS);
        this.chargerEdges = pruneExpiredEvLinkEdges(this.chargerEdges, nowMs, EDGE_RETENTION_MS);

        this.flushPendingSocShadows(chargers);
        this.watchSelfStop(chargers, nowMs);
    }

    private ingestChargerEdges(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        for (const charger of chargers) {
            const previous = this.lastChargerState.get(charger.id);
            const hadEntry = this.lastChargerState.has(charger.id);
            this.lastChargerState.set(charger.id, charger.evChargingState);
            if (!hadEntry) continue;
            const kind = resolveEvLinkEdge(previous, charger.evChargingState);
            if (kind === null) continue;
            this.chargerEdges = appendEvLinkEdge(this.chargerEdges, { deviceId: charger.id, kind, atMs: nowMs });
            if (kind === 'disconnect') this.clearSession(charger.id);
        }
    }

    private applyCoincidences(
        coincidences: readonly EvLinkCoincidence[],
        chargers: readonly EvCarLinkChargerView[],
        nowMs: number,
    ): void {
        for (const coincidence of coincidences) {
            // Keyed on the charger-edge time as well as the pair: without it a
            // second session's plug-in reuses the first session's key and is
            // skipped, so votes could never accumulate past one per direction.
            const key = `${coincidence.carId}|${coincidence.chargerId}|${coincidence.kind}|${coincidence.atMs}`;
            if (!this.claimReportKey(key)) continue;

            const voted = recordEvCarLinkVote({
                snapshot: this.deps.getSnapshot(),
                carId: coincidence.carId,
                chargerId: coincidence.chargerId,
                nowMs,
            });
            this.deps.setSnapshot(voted);
            const votes = getEvCarLinkVotes(voted, coincidence.carId, coincidence.chargerId);
            const charger = chargers.find((entry) => entry.id === coincidence.chargerId);
            this.deps.emit({
                component: 'devices',
                event: 'ev_car_link_candidate',
                carId: coincidence.carId,
                carName: this.carName(coincidence.carId),
                chargerId: coincidence.chargerId,
                chargerName: charger?.name ?? coincidence.chargerId,
                kind: coincidence.kind,
                deltaMs: coincidence.deltaMs,
                votes,
            });
            if (coincidence.kind === 'connect') {
                this.resolveSession(coincidence.chargerId, charger, coincidence.carId);
            }
        }
    }

    /**
     * Commit the car a charger is serving for this session. A live coincidence
     * wins outright; otherwise the persisted affinity prior may break the tie
     * only under the strict conditions in `resolveLinkForCharger`.
     */
    private resolveSession(
        chargerId: string,
        charger: EvCarLinkChargerView | undefined,
        coincidentCarId?: string,
    ): void {
        const snapshot = this.deps.getSnapshot();
        const resolution = resolveLinkForCharger({
            coincidentCarId,
            candidateCarIds: [...this.cars.keys()],
            votesFor: (carId) => getEvCarLinkVotes(snapshot, carId, chargerId),
        });
        if (resolution === null) return;
        const existing = this.activeLinks.get(chargerId);
        if (existing?.carId === resolution.carId && existing.source === resolution.source) return;
        this.activeLinks.set(chargerId, { carId: resolution.carId, source: resolution.source });
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_link_resolved',
            carId: resolution.carId,
            carName: this.carName(resolution.carId),
            chargerId,
            chargerName: charger?.name ?? chargerId,
            votes: resolution.votes,
            source: resolution.source,
        });
    }

    private reportAmbiguities(
        ambiguities: readonly EvLinkAmbiguity[],
        chargers: readonly EvCarLinkChargerView[],
    ): void {
        for (const ambiguity of ambiguities) {
            const key = `ambiguous|${ambiguity.chargerId}|${ambiguity.kind}|${ambiguity.atMs}`;
            if (!this.claimReportKey(key)) continue;
            this.deps.emit({
                component: 'devices',
                event: 'ev_car_link_ambiguous',
                chargerId: ambiguity.chargerId,
                chargerName: chargers.find((entry) => entry.id === ambiguity.chargerId)?.name ?? ambiguity.chargerId,
                carIds: ambiguity.carIds,
                kind: ambiguity.kind,
            });
        }
    }

    /**
     * A car edge older than the coincidence window that never paired means the
     * car connected somewhere other than a PELS-known charger. Reported once per
     * edge; it carries NO vote in either direction.
     */
    private reportSessionsElsewhere(unmatched: readonly EvLinkEdge[], nowMs: number): void {
        for (const edge of unmatched) {
            if (edge.kind !== 'connect') continue;
            if (nowMs - edge.atMs <= EV_CAR_LINK_COINCIDENCE_WINDOW_MS) continue;
            const key = `elsewhere|${edge.deviceId}|${edge.atMs}`;
            if (!this.claimReportKey(key)) continue;
            this.deps.emit({
                component: 'devices',
                event: 'ev_car_session_elsewhere',
                carId: edge.deviceId,
                carName: this.carName(edge.deviceId),
                reason: 'no_charger_edge',
            });
        }
    }

    /**
     * Watch each linked charger for the car stopping of its own accord, and for
     * the car's charge climbing while this charger delivers nothing (which proves
     * it is plugged in elsewhere regardless of what the plug edges said).
     */
    private watchSelfStop(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        for (const charger of chargers) {
            const link = this.activeLinks.get(charger.id);
            const car = link ? this.cars.get(link.carId) : undefined;
            if (!link || !car) continue;

            const reason = classifyEvCarSelfStop({
                carState: car.state,
                chargerState: charger.evChargingState,
                chargerCommandedOn: charger.controlOn,
                chargerPowerW: charger.measuredPowerW,
            });
            // The condition broke: the car resumed, the charger stopped believing
            // it was delivering, or real draw returned. Reset the dwell clock so
            // the next episode is timed from its own start, and re-arm reporting.
            if (reason === null) {
                this.selfStopSinceMs.delete(charger.id);
                this.selfStopReported.delete(charger.id);
                continue;
            }
            const since = this.selfStopSinceMs.get(charger.id) ?? nowMs;
            if (!this.selfStopSinceMs.has(charger.id)) this.selfStopSinceMs.set(charger.id, nowMs);
            const heldForMs = nowMs - since;
            if (heldForMs < EV_CAR_LINK_SELF_STOP_MIN_MS) continue;
            if (this.selfStopReported.has(charger.id)) continue;

            this.selfStopReported.add(charger.id);
            this.emitSelfStop({ charger, link, car, reason, heldForMs, nowMs });
        }
    }

    private emitSelfStop(params: {
        charger: EvCarLinkChargerView;
        link: ActiveLink;
        car: CarObservation;
        reason: EvCarSelfStopReason;
        heldForMs: number;
        nowMs: number;
    }): void {
        const { charger, link, car, reason, heldForMs, nowMs } = params;
        if (car.socPct !== null) {
            this.deps.setSnapshot(recordEvCarSelfStopSoc({
                snapshot: this.deps.getSnapshot(),
                carId: link.carId,
                socPct: car.socPct,
                nowMs,
            }));
        }
        const limit = summarizeEvCarObservedLimit(this.deps.getSnapshot(), link.carId);
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_self_stopped',
            carId: link.carId,
            carName: car.name,
            chargerId: charger.id,
            chargerName: charger.name,
            subReason: reason,
            stoppedAtSocPct: car.socPct,
            chargerPowerW: charger.measuredPowerW,
            heldForMs,
            observedLimitPct: limit?.medianPct ?? null,
            observedLimitSpreadPct: limit?.spreadPct ?? null,
            observedLimitSamples: limit?.sampleCount ?? 0,
        });
    }

    /**
     * Shadow comparison only: what the car reports versus what the existing flow
     * card already put on the charger. Never writes `stateOfCharge`, never
     * requests a plan rebuild. `wouldAdopt` records that PELS would have had a
     * value to write here, had adoption been enabled.
     *
     * Drained once per correlation pass, after links are resolved. A queued
     * reading for a car with no active link is discarded, not held: the next
     * reading supersedes it, and a stale one would compare against a charger
     * state that has since moved on.
     */
    private flushPendingSocShadows(chargers: readonly EvCarLinkChargerView[]): void {
        if (this.pendingSocShadows.size === 0) return;
        const pending = [...this.pendingSocShadows];
        this.pendingSocShadows.clear();
        for (const [deviceId, reading] of pending) {
            for (const [chargerId, link] of this.activeLinks) {
                if (link.carId !== deviceId) continue;
                const charger = chargers.find((entry) => entry.id === chargerId);
                if (charger) this.emitSocShadow(deviceId, charger, reading);
            }
        }
    }

    private emitSocShadow(
        carId: string,
        charger: EvCarLinkChargerView,
        reading: { previousSocPct: number | null; socPct: number },
    ): void {
        const { previousSocPct, socPct } = reading;
        const carName = this.carName(carId);
        if (isChargingElsewhere({
            previousSocPct,
            currentSocPct: socPct,
            chargerPowerW: charger.measuredPowerW,
        })) {
            this.deps.emit({
                component: 'devices',
                event: 'ev_car_session_elsewhere',
                carId,
                carName,
                reason: 'charger_idle_while_soc_rising',
            });
        }
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_link_soc_shadow',
            carId,
            carName,
            chargerId: charger.id,
            chargerName: charger.name,
            carSocPct: socPct,
            reportedSocPct: charger.reportedSocPct,
            deltaPct: charger.reportedSocPct === null
                ? null
                : Math.round((socPct - charger.reportedSocPct) * 10) / 10,
            wouldAdopt: true,
        });
    }

    /** Forget per-session state when the car unplugs; affinity votes survive. */
    private clearSession(chargerId: string): void {
        this.activeLinks.delete(chargerId);
        this.selfStopSinceMs.delete(chargerId);
        this.selfStopReported.delete(chargerId);
    }

    private carName(carId: string): string {
        return this.cars.get(carId)?.name ?? carId;
    }
}
