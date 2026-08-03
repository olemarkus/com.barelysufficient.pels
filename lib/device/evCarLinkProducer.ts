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
import type { AssociatedCarSnapshot, EvChargingState } from '../../packages/contracts/src/types';
import type { EvCarLinkEvent } from './evCarLinkEvents';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyDeviceLike } from '../utils/types';
import {
    collectAssociatedCarLevels,
    resolveAssociatedCarSnapshot,
    type ActiveLinkView,
} from './evCarLinkReadModel';
import { resolveResumableSessions } from './evCarLinkSessionResume';
import { EvCarSelfStopWatcher } from './evCarLinkSelfStop';
import {
    hasSessionPowerEvidence,
    type EvCarLinkChargerView,
} from './evCarLinkChargerView';
import {
    applyCarCapability,
    mergeCarObservation,
    readCarDevice,
    type CarObservation,
} from './evCarLinkObservation';
import {
    EV_CAR_LINK_AWAY_VERDICT_MS,
    EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
    EV_CAR_LINK_IDLE_POWER_W,
    type EvLinkAmbiguity,
    type EvLinkCoincidence,
    type EvLinkEdge,
    appendEvLinkEdge,
    isChargingElsewhere,
    isEvConnectedState,
    matchCoincidentEdges,
    pruneExpiredEvLinkEdges,
    resolveEvLinkEdge,
    resolveLinkForCharger,
} from './evCarLink';
import {
    clearEvCarLinkSession,
    getEvCarLinkVotes,
    recordEvCarLinkSession,
    recordEvCarLinkVote,
} from './evCarLinkSnapshot';

/**
 * Edges outlive the away verdict by one more window so an edge is still present
 * on the pass that reports it. Retention must exceed
 * `EV_CAR_LINK_AWAY_VERDICT_MS`, or an edge would be pruned before it could be
 * called an away session.
 */
const EDGE_RETENTION_MS = EV_CAR_LINK_COINCIDENCE_WINDOW_MS * 3;

/**
 * Consecutive targeted reads that must miss a car before it is dropped. One miss
 * cannot distinguish a deleted device from a transient read failure, and Homey
 * SDK reads do fail transiently — so give it a few rounds, the same shape as the
 * battery producer's narrowing grace.
 */
const EV_CAR_LINK_TARGETED_MISS_GRACE = 3;

/** Bound on the one-shot report-dedupe ring (see `claimReportKey`). */
const MAX_REPORTED_KEYS = 200;

export type { EvCarLinkEvent } from './evCarLinkEvents';
export type EvCarLinkEventEmitter = (payload: EvCarLinkEvent) => void;

/**
 * What we hold for one car. Plug state and charge are timestamped INDEPENDENTLY:
 * they are separate capabilities that change at different times, and gating both
 * on one timestamp lets a stale fetch roll charge backward whenever the plug
 * state happened not to change (which is most of a charging session).
 */
type ActiveLink = ActiveLinkView & { source: string };

export type EvCarLinkProducerDeps = {
    emit: EvCarLinkEventEmitter;
    /** Committed charger views; read lazily so the producer never holds snapshots. */
    getChargers: () => readonly EvCarLinkChargerView[];
    getSnapshot: () => EvCarLinkSnapshot;
    setSnapshot: (snapshot: EvCarLinkSnapshot) => void;
    /**
     * A fresh battery level from the car associated with `chargerId`. Fired
     * wherever the probe already computes `wouldAdopt`, so the probe still
     * decides nothing: the consumer applies the user's eligibility set and
     * decides whether to write anything.
     */
    onAssociatedCarStateOfCharge?: (reading: {
        chargerId: string;
        carId: string;
        socPct: number;
        socAtMs: number;
    }) => void;
    /** A charger's session ended (unplug, car removed, car moved to another charger). */
    onAssociationEnded?: (chargerId: string) => void;
};

export class EvCarLinkProducer {
    private carEdges: readonly EvLinkEdge[] = [];
    private chargerEdges: readonly EvLinkEdge[] = [];
    private readonly cars = new Map<string, CarObservation>();
    private readonly lastChargerState = new Map<string, EvChargingState>();
    private readonly activeLinks = new Map<string, ActiveLink>();
    /**
     * When each charger last STARTED reading idle. A single current idle sample
     * does not prove a charge rise happened while idle — PELS pausing a charger
     * right after the charge went up would otherwise read as an away session.
     */
    private readonly chargerIdleSinceMs = new Map<string, number>();
    /** Chargers first seen mid-session; resolved from the prior, never voted on. */
    private readonly coldStartChargerIds = new Set<string>();
    /** Chargers whose persisted session has already been resumed this run, so a
     *  resume is not re-emitted every correlation pass. */
    private readonly resumedChargerIds = new Set<string>();
    /** Consecutive targeted reads that requested a car and did not return it. */
    private readonly targetedMissesByCarId = new Map<string, number>();
    /** Charge readings awaiting link resolution; see `flushPendingSocShadows`. */
    private readonly pendingSocShadows = new Map<
        string,
        { previousSocPct?: number; socPct: number; socAtMs: number }
    >();
    /**
     * One-shot dedupe for events derived from retained edges, which are re-matched
     * on every correlation pass. Bounded by `MAX_REPORTED_KEYS`: edges expire long
     * before the cap, so eviction only ever discards keys whose edges are gone —
     * it cannot resurrect a duplicate for a live edge.
     */
    private reportedKeys: string[] = [];
    private readonly reportedKeySet = new Set<string>();

    private readonly selfStop: EvCarSelfStopWatcher;

    constructor(private readonly deps: EvCarLinkProducerDeps) {
        this.selfStop = new EvCarSelfStopWatcher({
            emit: deps.emit,
            getSnapshot: deps.getSnapshot,
            setSnapshot: deps.setSnapshot,
            carName: (carId) => this.carName(carId),
        });
    }

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

    /** This charger's car for the CURRENT session; rules in `evCarLinkReadModel.ts`. */
    getAssociatedCarForCharger(chargerId: string): AssociatedCarSnapshot | undefined {
        return resolveAssociatedCarSnapshot({ cars: this.cars, links: this.activeLinks, chargerId });
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
     * Re-run correlation without asserting anything about device membership.
     * Distinct from {@link observe}, which carries a device READ: an empty list
     * there means "the fetch returned no devices", which is evidence a car is
     * gone. Advancing the clock is not that evidence.
     */
    tick(nowMs: number): void {
        if (this.cars.size === 0) return;
        this.correlate(nowMs);
    }

    /**
     * Realtime per-capability seam. This is the ONLY path that carries capability
     * VALUE changes: `device.update` reports device-level changes, so without this
     * a car's plug state and charge never reach the probe between fetches, and
     * plug-edge correlation could never fire at realtime cadence.
     *
     * Must be called AFTER the inner capability handler has updated the snapshot,
     * so a charger event correlates against its own new state rather than the
     * previous one.
     */
    noteCapabilityUpdate(deviceId: string, capabilityId: string, value: unknown, nowMs: number): void {
        const previous = this.cars.get(deviceId);
        if (previous) {
            const next = applyCarCapability(previous, { capabilityId, value, atMs: nowMs });
            if (next) this.applyCarObservation(deviceId, previous, next, nowMs);
        }
        if (this.cars.size === 0) return;
        this.correlate(nowMs);
    }

    /**
     * Commit a merged car observation and derive everything keyed off it: the
     * plug edge, the immediate session clear on a car-side unplug, and the queued
     * charge shadow. Shared by the full-payload and per-capability paths so both
     * produce identical downstream behaviour.
     */
    private applyCarObservation(
        deviceId: string,
        previous: CarObservation | undefined,
        merged: CarObservation,
        nowMs: number,
    ): void {
        this.cars.set(deviceId, merged);
        const edgeKind = previous ? resolveEvLinkEdge(previous.state, merged.state) : null;
        if (edgeKind !== null) {
            this.carEdges = appendEvLinkEdge(this.carEdges, { deviceId, kind: edgeKind, atMs: nowMs });
        }
        // A trusted car-side unplug ends the session immediately. Waiting for the
        // charger to agree would strand the link whenever the charger's own update
        // is missed or stale, and later charge readings would then be shadowed
        // against a charger the car has left.
        if (edgeKind === 'disconnect') this.clearSessionsForCar(deviceId);
        if (merged.socPct !== undefined && previous?.socPct !== merged.socPct) {
            this.pendingSocShadows.set(deviceId, {
                ...(previous?.socPct === undefined ? {} : { previousSocPct: previous.socPct }),
                socPct: merged.socPct,
                socAtMs: merged.socAtMs,
            });
        }
    }

    /**
     * Consult a SUCCESSFULLY fetched device list.
     *
     * A FULL read is authoritative on membership: a car removed from Homey is
     * dropped. That matters because the affinity fallback treats every tracked
     * car as a candidate, so a deleted car with persisted votes could otherwise
     * be resolved as the owner of a live session forever — and its id would be
     * re-requested on every targeted refresh.
     *
     * There is deliberately NO extra "non-empty list" guard here. This runs only
     * after the snapshot commit, and the refresh pipeline's own abandon-grace
     * (`shouldDeferEmptySnapshotCommit`) has already decided that an empty full
     * read is genuine rather than a transient miss. Re-gating on emptiness would
     * stack a second grace on top of that one and mean the LAST car could never
     * be pruned at all. A targeted read re-reads only known ids and never
     * narrows, because `fullRefresh` is false for it.
     */
    observe(devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean; nowMs: number }): void {
        const seen = new Set<string>();
        for (const device of devices) {
            if (this.ingestCar(device, options.nowMs)) seen.add(device.id);
        }
        // Collect first, then delete: mutating the map mid-iteration needs a
        // snapshot, and the house rule bans spread allocations inside loops.
        const removed: string[] = [];
        for (const carId of this.cars.keys()) {
            if (seen.has(carId)) {
                this.targetedMissesByCarId.delete(carId);
                continue;
            }
            if (options.fullRefresh) {
                removed.push(carId);
                continue;
            }
            // A targeted read requests every tracked car by id, so an absent car
            // was either deleted or transiently unreadable. Those are
            // indistinguishable in one read, and the periodic refresh is ALWAYS
            // targeted — so without a miss count a deleted car is never dropped,
            // keeps being requested, and stays an affinity candidate forever.
            const misses = (this.targetedMissesByCarId.get(carId) ?? 0) + 1;
            this.targetedMissesByCarId.set(carId, misses);
            if (misses >= EV_CAR_LINK_TARGETED_MISS_GRACE) removed.push(carId);
        }
        for (const carId of removed) this.forgetCar(carId);
        this.correlate(options.nowMs);
    }

    /** Drop a car Homey no longer reports, plus anything keyed on it. */
    private forgetCar(carId: string): void {
        this.cars.delete(carId);
        this.targetedMissesByCarId.delete(carId);
        this.pendingSocShadows.delete(carId);
        this.carEdges = this.carEdges.filter((edge) => edge.deviceId !== carId);
        this.clearSessionsForCar(carId);
    }

    /**
     * End every session currently attributed to this car. Collect first, then
     * clear: `clearSession` mutates the map being iterated.
     */
    private clearSessionsForCar(carId: string): void {
        const chargerIds: string[] = [];
        for (const [chargerId, link] of this.activeLinks) {
            if (link.carId === carId) chargerIds.push(chargerId);
        }
        for (const chargerId of chargerIds) this.clearSession(chargerId);
    }

    /** Read a car device's official capabilities; returns whether it is a car at all. */
    private ingestCar(device: HomeyDeviceLike, nowMs: number): boolean {
        const reading = readCarDevice(device, nowMs);
        if (!reading) return false;
        const { deviceId } = reading;

        const previous = this.cars.get(deviceId);
        const merged = mergeCarObservation(previous, reading);
        // No readable plug state ever: stay untracked rather than hold an unknown.
        if (!merged) return true;
        this.applyCarObservation(deviceId, previous, merged, nowMs);
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

        // Hand the matcher EVERY retained charger edge: it needs the unsettled
        // ones to judge contention, and settles the decision itself.
        const match = matchCoincidentEdges({
            carEdges: this.carEdges,
            chargerEdges: this.chargerEdges,
            nowMs,
        });
        this.applyCoincidences(match.coincidences, chargers, nowMs);
        this.reportAmbiguities(match.ambiguities, chargers);
        this.resolveUnexplainedSessions(match.unmatchedChargerEdges, chargers);
        // BEFORE cold start: a persisted session is direct evidence about this
        // charger, where the cold-start path only has vote history to guess from.
        this.resumePersistedSessions(chargers);
        this.resolveColdStartSessions(chargers, nowMs);
        // Only edges the matcher could not explain, and only after their window
        // has closed. Matching runs BEFORE the prune below, so an edge always gets
        // at least one matched pass at every age up to retention — there is no
        // separate "about to expire" sweep, and adding one would report
        // successfully-linked edges as away sessions once they aged out.
        this.reportSessionsElsewhere(match.unmatchedCarEdges, nowMs);
        this.carEdges = pruneExpiredEvLinkEdges(this.carEdges, nowMs, EDGE_RETENTION_MS);
        this.chargerEdges = pruneExpiredEvLinkEdges(this.chargerEdges, nowMs, EDGE_RETENTION_MS);

        this.flushPendingSocShadows(chargers);
        this.publishAssociatedCarLevels();
        this.selfStop.watch({ chargers, nowMs, links: this.activeLinks, cars: this.cars });
    }

    private ingestChargerEdges(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        for (const charger of chargers) {
            const isIdle = charger.measuredPowerW !== undefined
                && charger.measuredPowerW <= EV_CAR_LINK_IDLE_POWER_W;
            if (!isIdle) this.chargerIdleSinceMs.delete(charger.id);
            else if (!this.chargerIdleSinceMs.has(charger.id)) {
                this.chargerIdleSinceMs.set(charger.id, nowMs);
            }
            const previous = this.lastChargerState.get(charger.id);
            this.lastChargerState.set(charger.id, charger.evChargingState);
            // No prior record: a first reading is not a plug event. But a charger
            // that is ALREADY connected here is mid-session — after a restart, say
            // — and will produce no connect edge at all, so without a prior pass
            // the whole session goes unlinked and its charge-shadow and self-stop
            // observations are lost. Remember it; `correlate` resolves it from the
            // persisted affinity WITHOUT manufacturing an edge or a vote.
            if (previous === undefined) {
                if (isEvConnectedState(charger.evChargingState)) this.coldStartChargerIds.add(charger.id);
                continue;
            }
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
            // Settling the CHARGER edge is not enough. Contention is decided per
            // CAR edge, and a competing charger can still connect up to one full
            // window after that car edge — by which time this pair would already
            // be finalized, holding a persisted vote and an active link that no
            // later pass can retract. Waiting one window past the car edge means
            // every charger that could contest it has been ingested before the
            // matcher's contest check runs, so the pair surfaces as an ambiguity
            // instead. Skipping leaves the key unclaimed, so a later pass
            // re-decides this same coincidence.
            const carEdgeAtMs = coincidence.atMs + coincidence.deltaMs;
            if (nowMs - carEdgeAtMs < EV_CAR_LINK_COINCIDENCE_WINDOW_MS) continue;
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
                this.resolveSession(coincidence.chargerId, charger, coincidence.atMs, coincidence.carId);
            }
        }
    }

    /**
     * A charger that plugged in but whose connect edge matched NO car edge at all
     * — the car's own update was missed, or its first observation after a restart
     * was already connected — still has a session. This is the ONLY path on which
     * the persisted affinity prior can decide, and without it the documented
     * `affinity_prior` source is unreachable: every other call site supplies a
     * live coincidence, which always wins.
     *
     * Takes only candidate-free edges, never merely unresolved ones. An AMBIGUOUS
     * edge has live candidates the matcher deliberately refused to choose between;
     * letting the prior pick one there would overturn that refusal and emit a
     * confident link alongside the ambiguity that contradicts it.
     */
    private resolveUnexplainedSessions(
        unmatchedChargerEdges: readonly EvLinkEdge[],
        chargers: readonly EvCarLinkChargerView[],
    ): void {
        for (const edge of unmatchedChargerEdges) {
            if (edge.kind !== 'connect') continue;
            if (this.activeLinks.has(edge.deviceId)) continue;
            this.resolveSession(edge.deviceId, chargers.find((entry) => entry.id === edge.deviceId), edge.atMs);
        }
    }

    /**
     * Whether a session may be opened at all: the charger must be connected NOW,
     * and so must the coincident car if one was supplied.
     *
     * The car check matters because a coincidence settles 90 s after the physical
     * connect, and the car may have unplugged in between — its own clear already
     * ran. Committing the delayed edge would resurrect the link and shadow later
     * charge readings against a car that has left. The prior path filters
     * candidates on connectedness; a live coincidence clears the same bar.
     */
    private canOpenSession(charger: EvCarLinkChargerView | undefined, coincidentCarId?: string): boolean {
        if (!charger || !isEvConnectedState(charger.evChargingState)) return false;
        if (coincidentCarId === undefined) return true;
        const coincidentCar = this.cars.get(coincidentCarId);
        return coincidentCar !== undefined && isEvConnectedState(coincidentCar.state);
    }

    /**
     * A charger first observed mid-session produces no connect edge, so the
     * edge-driven paths never see it. Resolve it from the persisted affinity
     * instead — no edge, no vote, so this can only ever recover a session that
     * history already explains.
     */
    private persistSession(chargerId: string, carId: string, sinceMs: number): void {
        this.deps.setSnapshot(recordEvCarLinkSession({
            snapshot: this.deps.getSnapshot(), chargerId, carId, sinceMs,
        }));
    }

    /** Applies whatever `resolveResumableSessions` says may be picked back up. */
    private resumePersistedSessions(chargers: readonly EvCarLinkChargerView[]): void {
        const resumable = resolveResumableSessions({
            sessions: this.deps.getSnapshot().sessions,
            chargers,
            cars: this.cars,
            isSettled: (id) => this.activeLinks.has(id) || this.resumedChargerIds.has(id),
        });
        for (const session of resumable) {
            this.resumedChargerIds.add(session.chargerId);
            this.activeLinks.set(session.chargerId, {
                carId: session.carId,
                sinceMs: session.sinceMs,
                source: 'resumed',
            });
            this.deps.emit({
                component: 'devices',
                event: 'ev_car_link_resumed',
                carId: session.carId,
                carName: this.carName(session.carId),
                chargerId: session.chargerId,
                chargerName: chargers.find((entry) => entry.id === session.chargerId)?.name ?? session.chargerId,
                sinceMs: session.sinceMs,
            });
        }
    }

    private resolveColdStartSessions(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        if (this.coldStartChargerIds.size === 0) return;
        // Drain into a plain array first: the house rule bans spread allocations
        // inside loops, and `resolveSession` mutates the set via `clearSession`.
        const pending: string[] = [];
        for (const chargerId of this.coldStartChargerIds) pending.push(chargerId);
        this.coldStartChargerIds.clear();
        for (const chargerId of pending) {
            if (this.activeLinks.has(chargerId)) continue;
            this.resolveSession(chargerId, chargers.find((entry) => entry.id === chargerId), nowMs);
        }
    }

    /**
     * Commit the car a charger is serving for this session. A live coincidence
     * wins outright; otherwise the persisted affinity prior may break the tie
     * only under the strict conditions in `resolveLinkForCharger`.
     *
     * Refuses outright for a charger that is not currently connected. Edges are
     * matched only after they settle, so a short session's connect edge can be
     * processed AFTER its disconnect has already cleared the session — without
     * this guard that would resurrect a link for an unplugged car and attribute
     * later charge readings and self-stops to it.
     */
    private resolveSession(
        chargerId: string,
        charger: EvCarLinkChargerView | undefined,
        /**
         * When the session physically began — the matched connect edge's own
         * time, NOT resolution time. Resolution lags the plug by a full settle
         * window, so stamping `now` here would date the session ~90 s late and
         * make a car that reported its final charge WITH the connect event look
         * stale to the self-stop currency gate. That is the "arrived already
         * full" case, which is exactly the stop the charge-limit statistic wants.
         */
        sessionStartedAtMs: number,
        coincidentCarId?: string,
    ): void {
        if (!this.canOpenSession(charger, coincidentCarId)) return;
        const snapshot = this.deps.getSnapshot();
        const resolution = resolveLinkForCharger({
            coincidentCarId,
            // Only cars currently reporting connected. A disconnected household
            // car with history would otherwise be the "unique qualified prior"
            // for a charger a guest car is actually on, and its later charge
            // updates would be attributed to a charger it is not attached to.
            candidateCarIds: [...this.cars.entries()]
                .filter(([, car]) => isEvConnectedState(car.state))
                .map(([carId]) => carId),
            votesFor: (carId) => getEvCarLinkVotes(snapshot, carId, chargerId),
        });
        if (resolution === null) return;
        const existing = this.activeLinks.get(chargerId);
        if (existing?.carId === resolution.carId && existing.source === resolution.source) return;
        // One car occupies one charger. A missed disconnect leaves the previous
        // charger's entry behind, and without this the same car would be linked
        // to both — charge readings attributed twice and self-stop reported
        // against a charger the car left. Collect first, then clear.
        const supersededChargerIds: string[] = [];
        for (const [otherChargerId, link] of this.activeLinks) {
            if (otherChargerId !== chargerId && link.carId === resolution.carId) {
                supersededChargerIds.push(otherChargerId);
            }
        }
        for (const otherChargerId of supersededChargerIds) this.clearSession(otherChargerId);
        this.activeLinks.set(chargerId, {
            carId: resolution.carId,
            source: resolution.source,
            sinceMs: sessionStartedAtMs,
        });
        // Persisted so a restart mid-session can offer to resume it; cleared on
        // every normal session end, so a stale entry can only survive an outage.
        this.persistSession(chargerId, resolution.carId, sessionStartedAtMs);
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
            if (nowMs - edge.atMs <= EV_CAR_LINK_AWAY_VERDICT_MS) continue;
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

    /** Offers each associated charger its car's current level; see the read model. */
    private publishAssociatedCarLevels(): void {
        const publish = this.deps.onAssociatedCarStateOfCharge;
        if (!publish) return;
        for (const reading of collectAssociatedCarLevels({ cars: this.cars, links: this.activeLinks })) {
            publish(reading);
        }
    }
    private flushPendingSocShadows(chargers: readonly EvCarLinkChargerView[]): void {
        if (this.pendingSocShadows.size === 0) return;
        const pending = [...this.pendingSocShadows];
        this.pendingSocShadows.clear();
        for (const [deviceId, reading] of pending) {
            for (const [chargerId, link] of this.activeLinks) {
                if (link.carId !== deviceId) continue;
                const charger = chargers.find((entry) => entry.id === chargerId);
                if (charger) this.emitSocShadow(deviceId, charger, reading, link.sinceMs);
            }
        }
    }

    private emitSocShadow(
        carId: string,
        charger: EvCarLinkChargerView,
        reading: { previousSocPct?: number; socPct: number; socAtMs: number },
        sessionStartedAtMs: number,
    ): void {
        const { previousSocPct, socPct, socAtMs } = reading;
        const carName = this.carName(carId);
        const idleSinceMs = this.chargerIdleSinceMs.get(charger.id);
        if (
            previousSocPct !== undefined
            // The idle reading must belong to THIS session. A charger that
            // reconnects carrying a retained idle value from the previous one is
            // not evidence it is delivering nothing now, and a charge rise while
            // it genuinely charges at home would be logged as an away session.
            && hasSessionPowerEvidence(charger, sessionStartedAtMs)
            && idleSinceMs !== undefined
            && isChargingElsewhere({
                previousSocPct,
                currentSocPct: socPct,
                currentSocAtMs: socAtMs,
                chargerPowerW: charger.measuredPowerW,
                chargerIdleSinceMs: idleSinceMs,
            })
        ) {
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
            ...(charger.reportedSocPct === undefined ? {} : {
                reportedSocPct: charger.reportedSocPct,
                deltaPct: Math.round((socPct - charger.reportedSocPct) * 10) / 10,
            }),
            wouldAdopt: true,
        });
        this.deps.onAssociatedCarStateOfCharge?.({
            chargerId: charger.id,
            carId,
            socPct,
            socAtMs: reading.socAtMs,
        });
    }

    /** Forget per-session state when the car unplugs; affinity votes survive. */
    private clearSession(chargerId: string): void {
        if (this.activeLinks.has(chargerId)) this.deps.onAssociationEnded?.(chargerId);
        this.activeLinks.delete(chargerId);
        this.deps.setSnapshot(clearEvCarLinkSession({ snapshot: this.deps.getSnapshot(), chargerId }));
        this.resumedChargerIds.delete(chargerId);
        this.coldStartChargerIds.delete(chargerId);
        this.selfStop.forget(chargerId);
        this.chargerIdleSinceMs.delete(chargerId);
    }

    private carName(carId: string): string {
        return this.cars.get(carId)?.name ?? carId;
    }
}
