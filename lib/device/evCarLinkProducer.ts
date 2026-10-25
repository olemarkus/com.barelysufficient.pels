/**
 * Read-only EV car-to-charger link producer.
 *
 * Mirrors `BatteryStateProducer` / `SolarProductionProducer`: consulted from the
 * same two seams (a SUCCESSFUL full device fetch, plus the realtime
 * `device.update` path), holds a small bounded state, and surfaces everything it
 * learns as structured events. Nothing it produces is read by planning,
 * admission, or actuation directly. What it offers the transport — an
 * associated car's battery level and qualified charge limit — is applied to an
 * opted-in charger there (`transport/carAssociation.ts`).
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
import type { AssociatedCarSnapshot, CarConfirmation, EvChargingState } from '../../packages/contracts/src/types';
import type { EvCarLinkEvent } from './evCarLinkEvents';
import type { EvCarChargerMatchHistory, EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyDeviceLike } from '../utils/types';
import { EvCarLinkWaitReporter } from './evCarLinkWaitReports';
import type { DeviceListRead } from './deviceListRead';
import { EvCarLinkReadMisses } from './evCarLinkReadMisses';
import {
    collectAssociatedCarLevels,
    resolveAssociatedCarSnapshot,
    type ActiveLinkView,
    type AssociatedCarLevel,
} from './evCarLinkReadModel';
import { isCarConfirmedElsewhere, isSavedCarUnobserved, resolveResumableSessions } from './evCarLinkSessionResume';
import { EvCarLinkSocShadowReporter } from './evCarLinkSocShadowReporter';
import { EvCarSelfStopWatcher } from './evCarLinkSelfStop';
import { EvCarLinkReportKeys } from './evCarLinkReportKeys';
import {
    finalLinks, findOtherLinksTo, findUnsupportedProvisionalLinks, mayOpenProvisionalLink, resolvePastMatchRefusal,
} from './evCarLinkProvisional';
import { admitsCar, type EvCarLinkChargerView } from './evCarLinkChargerView';
import { EvCarLinkRoster } from './evCarLinkRoster';
import {
    applyCarCapability,
    mergeCarObservation,
    readCarDevice,
    type CarObservation,
} from './evCarLinkObservation';
import {
    EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
    type EvLinkCoincidence,
    type EvLinkRefusalReason,
    type EvLinkEdge,
    type EvLinkEdgeHistory,
    appendEvLinkHistory,
    rememberEvLinkAmbiguities,
    ambiguitiesToRemember, dropEvLinkCarEdges,
    matchCoincidentEdges,
    pruneExpiredEvLinkEdges,
    resolveEvLinkEdge,
    decideLinkForCharger,
} from './evCarLink';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import {
    clearEvCarLinkSession,
    getEvCarLinkVotes,
    recordEvCarLinkSession,
    recordEvCarLinkVote,
    resolveEvCarChargerMatches,
} from './evCarLinkSnapshot';

/**
 * Edges outlive the away verdict by one more window so an edge is still present
 * on the pass that reports it. Retention must exceed
 * `EV_CAR_LINK_AWAY_VERDICT_MS`, or an edge would be pruned before it could be
 * called an away session.
 */
const EDGE_RETENTION_MS = EV_CAR_LINK_COINCIDENCE_WINDOW_MS * 3;

export type { EvCarLinkEvent } from './evCarLinkEvents';
export type EvCarLinkEventEmitter = (payload: EvCarLinkEvent) => void;

/**
 * What we hold for one car. Plug state and charge are timestamped INDEPENDENTLY:
 * they are separate capabilities that change at different times, and gating both
 * on one timestamp lets a stale fetch roll charge backward whenever the plug
 * state happened not to change (which is most of a charging session).
 */
/** A provisional link earns no vote and is not persisted (`evCarLinkProvisional.ts`). */
type ActiveLink = ActiveLinkView & { source: string; provisional: boolean };

/**
 * What {@link EvCarLinkProducer.resolveSession} did. `skipped`: the session it
 * was asked about is not the charger's current connection, so there is nothing
 * to report about it.
 */
type SessionOutcome = { kind: 'linked' } | { kind: 'skipped' }
    | { kind: 'refused'; reason: EvLinkRefusalReason; weighed: string[] };


export type EvCarLinkProducerDeps = {
    emit: EvCarLinkEventEmitter;
    /** Committed charger views; read lazily so the producer never holds snapshots. */
    getChargers: () => readonly EvCarLinkChargerView[];
    getSnapshot: () => EvCarLinkSnapshot;
    setSnapshot: (snapshot: EvCarLinkSnapshot) => void;
    /** Whether `getSnapshot` holds the whole history (see `EvCarLinkSnapshotAccess`). */
    historyResolved: boolean;
    /**
     * A fresh battery level from the car associated with `chargerId`. Fired
     * wherever the probe already computes `wouldAdopt`, so the probe still
     * decides nothing: the consumer applies the user's eligibility set and
     * decides whether to write anything.
     */
    onAssociatedCarStateOfCharge?: (reading: AssociatedCarLevel) => void;
    /** A car association ended or was suspended, so its derived level must be cleared. */
    onAssociationEnded?: (chargerId: string) => void;
};

export class EvCarLinkProducer {
    private edges: EvLinkEdgeHistory = { carEdges: [], chargerEdges: [] };
    /** Every tracked car in exactly one state; only observed cars are correlated. */
    private readonly cars = new EvCarLinkRoster();
    private readonly lastChargerState = new Map<string, EvChargingState>();
    private readonly chargerConnectedAtMs = new Map<string, number>();
    private readonly activeLinks = new Map<string, ActiveLink>();
    /** Chargers first seen mid-session; resolved from the prior, never voted on. */
    private readonly coldStartChargerIds = new Set<string>();
    /** Chargers whose persisted session has already been resumed this run, so a
     *  resume is not re-emitted every correlation pass. */
    private readonly resumedChargerIds = new Set<string>();
    /** Which tracked cars a read removes (`evCarLinkReadMisses.ts`). */
    private readonly readMisses = new EvCarLinkReadMisses();
    /** One-shot dedupe for events re-derived on every correlation pass. */
    private readonly reportKeys = new EvCarLinkReportKeys();

    private readonly selfStop: EvCarSelfStopWatcher;
    private readonly socShadows: EvCarLinkSocShadowReporter;
    /** Plug edges and waits, as the device journal and problem reports read them. */
    readonly waitReports: EvCarLinkWaitReporter;

    constructor(private readonly deps: EvCarLinkProducerDeps) {
        this.selfStop = new EvCarSelfStopWatcher({
            emit: deps.emit,
            getSnapshot: deps.getSnapshot,
            setSnapshot: deps.setSnapshot,
            carName: (carId) => this.carName(carId),
        });
        this.socShadows = new EvCarLinkSocShadowReporter(deps, this.selfStop, (carId) => this.carName(carId));
        this.waitReports = new EvCarLinkWaitReporter(
            deps.emit, this.cars, deps.getSnapshot, deps.getChargers, this.chargerConnectedAtMs,
            (chargerId) => this.activeLinks.has(chargerId)
                || deps.getSnapshot().sessions[chargerId]?.confirmed === true,
        );
    }

    /** This charger's car for the CURRENT session; rules in `evCarLinkReadModel.ts`. */
    getAssociatedCarForCharger(chargerId: string): AssociatedCarSnapshot | undefined {
        return resolveAssociatedCarSnapshot({ cars: this.cars.observed, links: this.activeLinks, chargerId });
    }

    getCarConfirmation(chargerId: string): CarConfirmation | undefined {
        const session = this.deps.getSnapshot().sessions[chargerId];
        if (!session?.confirmed) return undefined;
        const { carId } = session;
        return { carId, carName: this.carName(carId), available: this.cars.observed.has(carId) };
    }

    clearCarConfirmation(chargerId: string): void {
        if (this.deps.getSnapshot().sessions[chargerId]?.confirmed) this.clearSession(chargerId);
    }

    /** Explicit identification uses the current connection, never a notification's old session. */
    confirmAssociation(chargerId: string, carId: string, nowMs: number): void {
        const charger = this.deps.getChargers().find((entry) => entry.id === chargerId);
        if (!charger || !isEvPlugStateConnected(charger.evChargingState)) {
            throw new Error('The charger is not connected.');
        }
        if (!this.cars.observed.has(carId)) throw new Error('The selected car is unavailable.');
        const sessions = this.deps.getSnapshot().sessions;
        if (Object.entries(sessions).some(([id, session]) => id !== chargerId && session.carId === carId)
            || [...this.activeLinks].some(([id, link]) => id !== chargerId && link.carId === carId)) {
            throw new Error('The car is already associated with another charger.');
        }
        if (this.activeLinks.get(chargerId)?.carId === carId && this.activeLinks.get(chargerId)?.confirmed) return;
        this.clearSession(chargerId);
        const session = { carId, sinceMs: nowMs, confirmed: true as const };
        this.activeLinks.set(chargerId, { ...session, source: 'confirmed', provisional: false });
        this.deps.setSnapshot(recordEvCarLinkSession(this.deps.getSnapshot(), chargerId, session));
        this.deps.emit({ component: 'devices', event: 'ev_car_link_confirmed', chargerId, carId });
        this.publishAssociatedCarLevels();
    }

    /** Configuration and inventory invalidate confirmations even during a car outage. */
    retainConfirmedAssociations(isAllowed: (chargerId: string, carId: string) => boolean): void {
        for (const [chargerId, session] of Object.entries(this.deps.getSnapshot().sessions)) {
            if (session.confirmed && !isAllowed(chargerId, session.carId)) this.clearSession(chargerId);
        }
    }

    /** Chargers this car has matched, from the persisted votes; selection plays no part. */
    readChargerMatchesForCar(carId: string): EvCarChargerMatchHistory {
        if (!this.deps.historyResolved) return { state: 'unavailable' };
        return { state: 'resolved', chargerMatches: resolveEvCarChargerMatches(this.deps.getSnapshot(), carId) };
    }

    /**
     * Ids of the cars seen so far. Consumed by the targeted refresh, which
     * otherwise re-reads only devices that survived parse — and a car never does.
     * Without this the probe would depend entirely on the live feed, and a car
     * would go unobserved for as long as that feed was down.
     */
    getObservedCarDeviceIds(): string[] {
        return this.cars.ids();
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
        if (!this.cars.needsCorrelation()) return;
        this.correlate(nowMs);
    }

    /**
     * Re-run correlation without asserting anything about device membership.
     * Distinct from {@link observe}, which carries a device READ: an empty list
     * there means "the fetch returned no devices", which is evidence a car is
     * gone. Advancing the clock is not that evidence.
     */
    tick(nowMs: number): void {
        if (!this.cars.needsCorrelation()) return;
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
        const previous = this.cars.observed.get(deviceId);
        if (previous) {
            const next = applyCarCapability(previous, { capabilityId, value, atMs: nowMs });
            if (next) this.applyCarObservation(deviceId, previous, next, nowMs);
        }
        if (!this.cars.needsCorrelation()) return;
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
        this.cars.observe(deviceId, merged, nowMs);
        const edgeKind = previous ? resolveEvLinkEdge(previous.state, merged.state) : null;
        if (edgeKind !== null) {
            this.edges = appendEvLinkHistory(
                this.edges, 'carEdges', { deviceId, kind: edgeKind, atMs: nowMs }, this.admits,
            );
            this.waitReports.carEdge(deviceId, merged, edgeKind, nowMs);
        }
        // A trusted car-side unplug ends the session immediately. Waiting for the
        // charger to agree would strand the link whenever the charger's own update
        // is missed or stale, and later charge readings would then be shadowed
        // against a charger the car has left.
        if (edgeKind === 'disconnect') this.clearSessionsForCar(deviceId);
        if (merged.socPct !== undefined && previous?.socPct !== merged.socPct) {
            this.socShadows.hold(deviceId, {
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
     * be pruned at all. A targeted read re-reads only known ids, so a car it
     * misses is dropped only on the miss grace below.
     */
    observe(read: DeviceListRead, options: { fullRefresh: boolean; nowMs: number }): void {
        const seen = new Set<string>();
        for (const device of read.devices) {
            if (this.ingestCar(device, options.nowMs)) seen.add(device.id);
        }
        // Collected first, then forgotten: forgetting mutates the roster being read.
        const removed = this.readMisses.removedBy(
            this.getObservedCarDeviceIds(), seen, read.ignoredIds, options.fullRefresh, options.nowMs);
        for (const carId of removed) this.forgetCar(carId, options.nowMs);
        this.correlate(options.nowMs);
    }

    /** Drop a car Homey no longer reports, plus anything keyed on it. */
    private forgetCar(carId: string, nowMs: number): void {
        this.cars.forget(carId);
        this.readMisses.forget(carId);
        this.socShadows.drop(carId);
        this.edges = dropEvLinkCarEdges(this.edges, carId, nowMs, this.admits);
        this.clearSessionsForCar(carId);
    }

    /**
     * End every session currently attributed to this car. Collect first, then
     * clear: `clearSession` mutates the map being iterated.
     */
    private clearSessionsForCar(carId: string, preservePersistedSession = false): void {
        const chargerIds: string[] = [];
        for (const [chargerId, link] of this.activeLinks) {
            if (link.carId === carId) chargerIds.push(chargerId);
        }
        // A suspended unavailable car has no active link, but its session is
        // deliberately persisted for recovery. Actual device removal must clear
        // that record too or a deleted car id survives in storage forever.
        if (!preservePersistedSession) {
            for (const [chargerId, session] of Object.entries(this.deps.getSnapshot().sessions)) {
                if (session.carId === carId && !chargerIds.includes(chargerId)) chargerIds.push(chargerId);
            }
        }
        for (const chargerId of chargerIds) this.clearSession(chargerId, preservePersistedSession);
    }

    /** Read a car device's official capabilities; returns whether it is a car at all. */
    private ingestCar(device: HomeyDeviceLike, nowMs: number): boolean {
        const result = readCarDevice(device, nowMs);
        if (!result) return false;
        if (result.kind === 'unavailable') {
            this.cars.markUnavailable(result.deviceId, result.name);
            this.socShadows.drop(result.deviceId);
            this.edges = dropEvLinkCarEdges(this.edges, result.deviceId, nowMs, this.admits);
            this.clearSessionsForCar(result.deviceId, true);
            return true;
        }
        const { reading } = result;
        const { deviceId } = reading;

        const previous = this.cars.observed.get(deviceId);
        const merged = mergeCarObservation(previous, reading);
        // No readable plug state ever: hold no observation rather than an
        // unknown, but keep requesting the car so a readable state is seen.
        if (!merged) {
            this.cars.markUnread(deviceId, reading.name);
            return true;
        }
        this.applyCarObservation(deviceId, previous, merged, nowMs);
        return true;
    }

    /**
     * Sample charger views, diff them into edges, then run every correlation lane.
     *
     * A charger edge is only decided once it has SETTLED — one full coincidence
     * window has elapsed since it happened. Deciding eagerly would vote for the
     * first car to plug in and be unable to retract that vote when a second car
     * connects moments later at the same charger, which is exactly the two-car
     * household this probe has to survive. The vote and the persisted session
     * wait one full window after both endpoints report their plug edges.
     *
     * The link does not wait. A pairing with exactly one car and no rival yet
     * opens a provisional link at once, so the car's battery level reaches the
     * charger as soon as both plug edges are in. A rival inside the window makes
     * the edge ambiguous and withdraws the link; the settled decision makes it
     * final.
     */
    private correlate(nowMs: number): void {
        const chargers = this.deps.getChargers();
        this.ingestChargerEdges(chargers, nowMs);
        // Keep observing charger disconnects while every car is in an outage so
        // they can disprove a preserved session, but retain no correlation edge
        // that could later be matched against data from after the outage.
        if (this.cars.observed.size === 0) { this.edges.carEdges = []; this.edges.chargerEdges = []; return; }

        // Hand the matcher EVERY retained charger edge: it needs the unsettled
        // ones to judge contention, and settles the decision itself.
        const match = matchCoincidentEdges({ ...this.edges, nowMs, admits: this.admits });
        // Remembered only when its evidence is about to go (`ambiguitiesToRemember`).
        this.edges.chargerEdges = rememberEvLinkAmbiguities(
            this.edges.chargerEdges, ambiguitiesToRemember(match.ambiguousBursts, nowMs, EDGE_RETENTION_MS));
        this.withdrawUnsupportedProvisionalLinks([...match.provisionalCoincidences, ...match.coincidences]);
        this.applyCoincidences(match.coincidences, chargers, nowMs);
        for (const pairing of match.provisionalCoincidences) this.openProvisionalLink(pairing, chargers);
        this.reportKeys.reportAmbiguities(match.ambiguities, chargers, this.deps.emit);
        this.resolveUnexplainedSessions(match.unmatchedChargerEdges, chargers);
        this.reportSetAsideSessions(match.setAsideChargerEdges, chargers);
        // BEFORE cold start: a persisted session is direct evidence about this
        // charger, where the cold-start path only has vote history to guess from.
        this.resumePersistedSessions(chargers);
        this.resolveColdStartSessions(chargers, nowMs);
        // Only edges the matcher could not explain, and only after their window
        // has closed. Matching runs BEFORE the prune below, so an edge always gets
        // at least one matched pass at every age up to retention — there is no
        // separate "about to expire" sweep, and adding one would report
        // successfully-linked edges as away sessions once they aged out.
        this.reportKeys.reportSessionsElsewhere(match.unmatchedCarEdges, nowMs, this.carName, this.deps.emit);
        this.edges.carEdges = pruneExpiredEvLinkEdges(this.edges.carEdges, nowMs, EDGE_RETENTION_MS);
        this.edges.chargerEdges = pruneExpiredEvLinkEdges(this.edges.chargerEdges, nowMs, EDGE_RETENTION_MS);

        this.socShadows.flush(chargers, this.activeLinks);
        this.publishAssociatedCarLevels();
        // Self-stop evidence is persisted, so only a final link may produce it.
        this.selfStop.watch(chargers, nowMs, finalLinks(this.activeLinks), this.cars.observed);
    }

    private ingestChargerEdges(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        this.selfStop.notePower(chargers, nowMs);
        for (const charger of chargers) {
            const previous = this.lastChargerState.get(charger.id);
            this.lastChargerState.set(charger.id, charger.evChargingState);
            // No prior record: a first reading is not a plug event. But a charger
            // that is ALREADY connected here is mid-session — after a restart, say
            // — and will produce no connect edge at all, so without a prior pass
            // the whole session goes unlinked and its charge-shadow and self-stop
            // observations are lost. Remember it; `correlate` resolves it from the
            // persisted affinity WITHOUT manufacturing an edge or a vote.
            if (previous === undefined) {
                if (isEvPlugStateConnected(charger.evChargingState)) {
                    this.coldStartChargerIds.add(charger.id);
                    this.waitReports.chargerConnectedAtStart(charger.id);
                    this.chargerConnectedAtMs.set(charger.id, nowMs);
                }
                continue;
            }
            const kind = resolveEvLinkEdge(previous, charger.evChargingState);
            if (kind === null) continue;
            this.edges = appendEvLinkHistory(
                this.edges, 'chargerEdges', { deviceId: charger.id, kind, atMs: nowMs }, this.admits,
            );
            this.waitReports.chargerEdge(charger, kind, charger.evChargingState);
            if (kind === 'connect') this.chargerConnectedAtMs.set(charger.id, nowMs);
            else this.chargerConnectedAtMs.delete(charger.id);
            // The charger reported its car gone. When the linked car still reports
            // connected, the charger may simply have ended the session at the
            // car's limit (an Easee reads `plugged_out` then), so the self-stop
            // watcher keeps watching that pair after the association ends.
            if (kind !== 'disconnect') continue;
            const ended = this.clearSession(charger.id);
            this.selfStop.linger(charger.id, ended?.provisional ? undefined : ended, this.cars.observed, nowMs);
        }
    }

    getTaskDeliveryConstraint = (chargerId: string) => this.selfStop.getTaskDeliveryConstraint(
        chargerId, this.deps.getChargers(), finalLinks(this.activeLinks), this.cars.observed);

    noteStopCommand(chargerId: string, nowMs: number): void { this.selfStop.noteStopCommand(chargerId, nowMs); }

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
            // Until then the pairing is still provisional.
            const carEdgeAtMs = coincidence.atMs + coincidence.deltaMs;
            if (nowMs - carEdgeAtMs < EV_CAR_LINK_COINCIDENCE_WINDOW_MS) {
                this.openProvisionalLink(coincidence, chargers);
                continue;
            }
            // Keyed on the charger-edge time as well as the pair: without it a
            // second session's plug-in reuses the first session's key and is
            // skipped, so votes could never accumulate past one per direction.
            const key = `${coincidence.carId}|${coincidence.chargerId}|${coincidence.kind}|${coincidence.atMs}`;
            if (!this.reportKeys.claim(key)) continue;

            const voted = recordEvCarLinkVote(
                this.deps.getSnapshot(), coincidence.carId, coincidence.chargerId, nowMs,
            );
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

    /** Link the one car a charger's unsettled connect pairs with (`mayOpenProvisionalLink`). */
    private openProvisionalLink(pairing: EvLinkCoincidence, chargers: readonly EvCarLinkChargerView[]): void {
        const { chargerId, carId, atMs } = pairing;
        const charger = chargers.find((entry) => entry.id === chargerId);
        if (!charger || !mayOpenProvisionalLink(this.activeLinks, pairing)
            || !this.canOpenSession(charger, atMs, carId)) return;
        this.activeLinks.set(chargerId, { carId, source: 'coincidence', sinceMs: atMs, provisional: true });
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_link_provisional',
            carId,
            carName: this.carName(carId),
            chargerId,
            chargerName: charger.name,
            deltaMs: pairing.deltaMs,
        });
    }

    /**
     * A provisional link stands only while the pairing it came from does: a rival
     * that made its edge ambiguous, or a charger that turned out to admit its car
     * elsewhere, withdraws it.
     */
    private withdrawUnsupportedProvisionalLinks(pairings: readonly EvLinkCoincidence[]): void {
        for (const chargerId of findUnsupportedProvisionalLinks(this.activeLinks, pairings)) {
            const link = this.clearSession(chargerId);
            if (link) {
                this.deps.emit({
                    component: 'devices', event: 'ev_car_link_provisional_withdrawn', carId: link.carId, chargerId,
                });
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
            // The first settled pass decides whether the timeout is said, whatever
            // it finds; later passes retry the link, so a car update missed at the
            // plug-in can still link through past matches, never one that first
            // reported connected after the window (`resolveSession`), and the
            // timeout is never said again.
            const firstPass = this.reportKeys.claim(`unmatched|${edge.deviceId}|${edge.atMs}`);
            if (this.activeLinks.has(edge.deviceId)) continue;
            const charger = chargers.find((entry) => entry.id === edge.deviceId);
            const outcome = this.resolveSession(edge.deviceId, charger, edge.atMs);
            if (firstPass && outcome.kind === 'refused' && charger) {
                this.waitReports.unmatched(charger, outcome.reason, outcome.weighed);
            }
        }
    }

    /** A plug-in whose only fitting cars belong to another charger: no car here, said once. */
    private reportSetAsideSessions(edges: readonly EvLinkEdge[], chargers: readonly EvCarLinkChargerView[]): void {
        for (const edge of edges) {
            const charger = chargers.find((entry) => entry.id === edge.deviceId);
            if (edge.kind !== 'connect' || !charger || this.activeLinks.has(edge.deviceId)) continue;
            if (this.chargerConnectedAtMs.get(edge.deviceId) !== edge.atMs) continue;
            if (!this.reportKeys.claim(`unmatched|${edge.deviceId}|${edge.atMs}`)) continue;
            this.waitReports.unmatched(charger, 'explained_at_another_charger', []);
        }
    }

    /**
     * Whether a session may be opened at all: the charger must be connected NOW,
     * and so must the coincident car if one was supplied.
     *
     * The car check matters because a coincidence settles one window after the observed
     * connect, and the car may have unplugged in between — its own clear already
     * ran. Committing the delayed edge would resurrect the link and shadow later
     * charge readings against a car that has left. The prior path filters
     * candidates on connectedness; a live coincidence clears the same bar.
     */
    private canOpenSession(charger: EvCarLinkChargerView, startedAtMs: number, coincidentCarId?: string): boolean {
        if (!isEvPlugStateConnected(charger.evChargingState)) return false;
        // A settled historical edge cannot identify a different connection.
        if (this.chargerConnectedAtMs.get(charger.id) !== startedAtMs) return false;
        if (this.deps.getSnapshot().sessions[charger.id]?.confirmed) return false;
        if (coincidentCarId === undefined) return true;
        if (isCarConfirmedElsewhere(this.deps.getSnapshot().sessions, charger.id, coincidentCarId)) return false;
        const coincidentCar = this.cars.observed.get(coincidentCarId);
        return coincidentCar !== undefined && isEvPlugStateConnected(coincidentCar.state);
    }

    /** Applies whatever `resolveResumableSessions` says may be picked back up. */
    private resumePersistedSessions(chargers: readonly EvCarLinkChargerView[]): void {
        const verdict = resolveResumableSessions(
            this.deps.getSnapshot().sessions,
            chargers,
            this.cars.observed,
            (id) => this.activeLinks.has(id) || this.resumedChargerIds.has(id),
        );
        // Disproved first: a remembered endpoint reporting disconnected means that
        // session is over. Keeping the record would let the pair resume later on
        // unrelated connections — the old car plugging in at work while a guest
        // car uses this charger.
        for (const chargerId of verdict.forget) {
            this.deps.setSnapshot(clearEvCarLinkSession({ snapshot: this.deps.getSnapshot(), chargerId }));
        }
        for (const session of verdict.resume) {
            this.resumedChargerIds.add(session.chargerId);
            this.activeLinks.set(session.chargerId, {
                carId: session.carId,
                sinceMs: session.sinceMs,
                source: session.confirmed ? 'confirmed' : 'resumed',
                confirmed: session.confirmed,
                provisional: false,
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

    /**
     * A charger first observed mid-session has no connect edge; history may
     * identify it without earning a vote. A refusal is retried on every pass
     * until the window closes, since the car on it may still be recovering from
     * an outage while another car reads; only then is the timeout said, as for a
     * charger whose plug-in PELS saw. While its saved session's car is still
     * unobserved it waits for that car instead, so the resume can take it back,
     * and a charger missing from one pass is kept rather than dropped.
     */
    private resolveColdStartSessions(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        if (this.coldStartChargerIds.size === 0) return;
        // Drain into a plain array first: the house rule bans spread allocations
        // inside loops, and `resolveSession` mutates the set via `clearSession`.
        const pending: string[] = [];
        for (const chargerId of this.coldStartChargerIds) pending.push(chargerId);
        this.coldStartChargerIds.clear();
        for (const chargerId of pending) {
            if (this.activeLinks.has(chargerId)) continue;
            const connectedAtMs = this.chargerConnectedAtMs.get(chargerId);
            if (connectedAtMs === undefined) continue;
            // Car availability can defer cold-start resolution beyond the pass
            // that first observed this charger already connected.
            const charger = chargers.find((entry) => entry.id === chargerId);
            const inWindow = nowMs - connectedAtMs < EV_CAR_LINK_COINCIDENCE_WINDOW_MS;
            if (inWindow && (!charger
                || isSavedCarUnobserved(this.deps.getSnapshot().sessions, chargerId, this.cars.observed))) {
                this.coldStartChargerIds.add(chargerId);
                continue;
            }
            const outcome = this.resolveSession(chargerId, charger, connectedAtMs);
            if (outcome.kind !== 'refused' || !charger) continue;
            if (inWindow) this.coldStartChargerIds.add(chargerId);
            else this.waitReports.unmatched(charger, outcome.reason, outcome.weighed);
        }
    }

    /**
     * Commit the car a charger is serving for this session. A live coincidence
     * wins outright; otherwise the persisted affinity prior may break the tie
     * only under the strict conditions in `decideLinkForCharger`.
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
         * window, so stamping `now` here would date the session one window late and
         * make a car that reported its final charge WITH the connect event look
         * stale to the self-stop currency gate. That is the "arrived already
         * full" case, which is exactly the stop the charge-limit statistic wants.
         */
        sessionStartedAtMs: number,
        coincidentCarId?: string,
    ): SessionOutcome {
        if (!charger || !this.canOpenSession(charger, sessionStartedAtMs, coincidentCarId)) return { kind: 'skipped' };
        const snapshot = this.deps.getSnapshot();
        // Only cars currently reporting connected. A disconnected household
        // car with history would otherwise be the "unique qualified prior"
        // for a charger a guest car is actually on, and its later charge
        // updates would be attributed to a charger it is not attached to.
        const weighed = this.cars.connectedCarIds();
        const decision = decideLinkForCharger({
            coincidentCarId,
            candidateCarIds: weighed,
            votesFor: (carId) => getEvCarLinkVotes(snapshot, carId, chargerId),
        });
        if (decision.kind === 'refused') return { ...decision, weighed };
        const { resolution } = decision;
        // A late car stays a rival above; past matches only refuse to pick it.
        const refusal = resolvePastMatchRefusal(this.cars, this.activeLinks, chargerId, resolution, sessionStartedAtMs);
        if (refusal !== null) return { kind: 'refused', reason: refusal, weighed };
        if (isCarConfirmedElsewhere(snapshot.sessions, chargerId, resolution.carId)) {
            return { kind: 'refused', reason: 'car_confirmed_elsewhere', weighed };
        }
        const existing = this.activeLinks.get(chargerId);
        if (existing?.carId === resolution.carId && existing.source === resolution.source && !existing.provisional) {
            return { kind: 'linked' };
        }
        // One car occupies one charger. A missed disconnect leaves the previous
        // charger's entry behind, and without this the same car would be linked
        // to both — charge readings attributed twice and self-stop reported
        // against a charger the car left. Collect first, then clear.
        for (const otherChargerId of findOtherLinksTo(this.activeLinks, chargerId, resolution.carId)) {
            this.clearSession(otherChargerId);
        }
        this.activeLinks.set(chargerId, {
            carId: resolution.carId,
            source: resolution.source,
            sinceMs: sessionStartedAtMs,
            provisional: false,
        });
        // Persisted so a restart mid-session can offer to resume it; cleared on
        // every normal session end, so a stale entry can only survive an outage.
        this.deps.setSnapshot(recordEvCarLinkSession(this.deps.getSnapshot(), chargerId,
            { carId: resolution.carId, sinceMs: sessionStartedAtMs }));
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_link_resolved',
            carId: resolution.carId,
            carName: this.carName(resolution.carId),
            chargerId,
            chargerName: charger.name,
            votes: resolution.votes,
            source: resolution.source,
        });
        return { kind: 'linked' };
    }


    /** Offers each associated charger its car's current level; see the read model. */
    private publishAssociatedCarLevels(): void {
        const publish = this.deps.onAssociatedCarStateOfCharge;
        if (!publish) return;
        const readings = collectAssociatedCarLevels(this.cars.observed, this.activeLinks, this.deps.getSnapshot());
        for (const reading of readings) publish(reading);
    }
    /** Forget per-session state when the car unplugs; affinity votes survive. Returns the link it ended. */
    private clearSession(chargerId: string, preservePersistedSession = false): ActiveLink | undefined {
        const link = this.activeLinks.get(chargerId);
        if (link) this.deps.onAssociationEnded?.(chargerId);
        this.activeLinks.delete(chargerId);
        if (!preservePersistedSession) {
            const session = this.deps.getSnapshot().sessions[chargerId];
            if (session?.confirmed) this.deps.emit({
                component: 'devices', event: 'ev_car_link_confirmation_ended', chargerId, carId: session.carId,
            });
            this.deps.setSnapshot(clearEvCarLinkSession({ snapshot: this.deps.getSnapshot(), chargerId }));
        }
        this.resumedChargerIds.delete(chargerId);
        this.coldStartChargerIds.delete(chargerId);
        this.selfStop.forget(chargerId);
        return link;
    }

    // The owner's selection for a charger; one that left the list has none to apply.
    private readonly admits = (carId: string, chargerId: string): boolean => {
        const charger = this.deps.getChargers().find((entry) => entry.id === chargerId);
        return charger === undefined || admitsCar(charger, carId);
    };

    private carName = (carId: string): string => this.cars.name(carId) ?? carId;
}
