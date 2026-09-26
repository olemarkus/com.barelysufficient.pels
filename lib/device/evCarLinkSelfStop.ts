import type { EvCarLinkChargerView } from './evCarLinkChargerView';
import type { EvCarLinkEvent } from './evCarLinkEvents';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { CarObservation } from './evCarLinkObservation';
import { hasSessionPowerEvidence } from './evCarLinkChargerView';
import {
    EV_CAR_LINK_IDLE_POWER_W,
    EV_CAR_LINK_SELF_STOP_MIN_MS,
    classifyEvCarSelfStop,
    type EvCarSelfStopReason,
} from './evCarLink';
import {
    clearEvCarObservedStops,
    recordEvCarSelfStopSoc,
    resolveEvCarChargeLimit,
    summarizeEvCarObservedLimit,
} from './evCarLinkSnapshot';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';

/**
 * Detects a car stopping of its OWN accord — at its charge limit, on its own
 * schedule — and banks where it stopped as evidence of the car's charge limit.
 *
 * Split out of the producer because it owns its own episode bookkeeping and the
 * rules that keep that evidence the car's: the stop must follow delivery in this
 * session, no PELS stop command may explain it (`classifyEvCarSelfStop`), and an
 * unresolved power reading holds the dwell rather than ending the episode —
 * getting that last one wrong manufactures the two samples needed to publish a
 * false observed charge limit from a single physical stop.
 *
 * Design of record: `notes/ev-car-link/README.md`.
 */

/** The session record the watcher reads; the producer owns the live map. */
export type SelfStopLink = { carId: string; sinceMs: number };

/**
 * A link the charger ended while its car still reported connected. An Easee
 * ends the session at the car's limit and reads `plugged_out` with the car still
 * plugged in, which tears the link down before the car has even reported the
 * stop (production: the charger at 03:15:59, the car 17 s later). The watcher
 * keeps such a link to see that stop through, and for nothing else.
 *
 * A charger reads `plugged_out` on a physical unplug too, and a car app can lag
 * in reporting it. So a stop on a lingering link is banked only once the car has
 * stayed connected for {@link EV_CAR_LINK_LINGER_CONFIRM_MS} after the charger
 * let go — an unplugged car reports it well inside that (the Polestar in 17 s) —
 * and the link is dropped the moment the car links to another charger.
 */
type LingeringLink = SelfStopLink & { endedAtMs: number };

export const EV_CAR_LINK_LINGER_CONFIRM_MS = 10 * 60 * 1000;

/**
 * The confirm window plus one device poll (5 minutes with the live feed down)
 * and the dwell: the pass that first sees the car's stop can come that late.
 */
const EV_CAR_LINK_LINGER_MAX_MS = EV_CAR_LINK_LINGER_CONFIRM_MS + 5 * 60 * 1000 + EV_CAR_LINK_SELF_STOP_MIN_MS;

/** Slack above a qualified limit before the car's charge disproves it. */
const EV_CAR_LINK_LIMIT_DISPROOF_MARGIN_PCT = 1;

export type SelfStopDeps = {
    emit: (payload: EvCarLinkEvent) => void;
    getSnapshot: () => EvCarLinkSnapshot;
    setSnapshot: (snapshot: EvCarLinkSnapshot) => void;
    carName: (carId: string) => string;
};

export class EvCarSelfStopWatcher {
    /** Per charger: when the CURRENT episode began, and which reason it is. The
     *  reason is part of the episode identity — see `episodeStartMs`. */
    private readonly selfStopSince = new Map<
        string,
        { sinceMs: number; reason: EvCarSelfStopReason }
    >();
    private readonly selfStopReported = new Set<string>();
    private readonly lingering = new Map<string, LingeringLink>();
    /**
     * Per charger: the pass on which it was last seen drawing more than the idle
     * threshold, and when that reading was taken. The pass decides whether the
     * delivery belongs to this session — a charger holding a steady draw does
     * not re-report an unchanged value, so the reading's own time can predate
     * the session it was delivering in. The reading's time anchors the PELS-stop
     * window, because a delayed report keeps being seen after the pause.
     */
    private readonly lastDelivery = new Map<string, { seenAtMs: number; readingAtMs: number }>();
    /** Per charger: whether this session saw the car at or below its qualified limit. */
    private readonly sawCarWithinLimit = new Set<string>();
    /**
     * Per charger: when it last STARTED reading idle. A single current idle
     * sample does not prove a charge rise happened while idle — PELS pausing a
     * charger right after the charge went up would otherwise read as an away
     * session. Kept here with the delivery history, cleared with the session.
     */
    private readonly idleSinceMs = new Map<string, number>();
    /** Per charger: when PELS last told it to stop (`noteStopCommand`). */
    private readonly lastStopCommandAtMs = new Map<string, number>();

    constructor(private readonly deps: SelfStopDeps) {}

    /** Drops a charger's episode state and idle history when its session ends. */
    forget(chargerId: string): void {
        this.selfStopSince.delete(chargerId);
        this.selfStopReported.delete(chargerId);
        this.lingering.delete(chargerId);
        this.idleSinceMs.delete(chargerId);
        this.sawCarWithinLimit.delete(chargerId);
    }

    /**
     * Keep watching the link its charger just ended, if there was one and its
     * car was still connected when it did (see {@link LingeringLink}). Called
     * after `forget`.
     */
    linger(
        chargerId: string,
        link: SelfStopLink | undefined,
        cars: ReadonlyMap<string, CarObservation>,
        nowMs: number,
    ): void {
        const car = link ? cars.get(link.carId) : undefined;
        if (!link || car === undefined || !isEvPlugStateConnected(car.state)) return;
        this.lingering.set(chargerId, { ...link, endedAtMs: nowMs });
    }

    /** When the charger last started reading idle; absent while it draws, or unread. */
    chargerIdleSinceMs(chargerId: string): number | undefined {
        return this.idleSinceMs.get(chargerId);
    }

    /** Record each charger's draw at the start of a pass (see `lastDelivery`). */
    notePower(chargers: readonly EvCarLinkChargerView[], nowMs: number): void {
        for (const charger of chargers) {
            const { id, measuredPowerW } = charger;
            if (measuredPowerW === undefined) this.idleSinceMs.delete(id);
            else if (measuredPowerW > EV_CAR_LINK_IDLE_POWER_W) {
                this.idleSinceMs.delete(id);
                this.lastDelivery.set(id, { seenAtMs: nowMs, readingAtMs: charger.measuredPowerObservedAtMs ?? nowMs });
            } else if (!this.idleSinceMs.has(id)) this.idleSinceMs.set(id, nowMs);
        }
    }

    /** PELS told this charger to stop: a stop that follows is PELS's, not the car's. */
    noteStopCommand(chargerId: string, nowMs: number): void {
        this.lastStopCommandAtMs.set(chargerId, nowMs);
    }

    /**
     * Watch each linked charger for the car stopping of its own accord, and each
     * linked car for charging past the limit its stops had qualified.
     */
    watch(params: {
        chargers: readonly EvCarLinkChargerView[];
        nowMs: number;
        links: ReadonlyMap<string, SelfStopLink>;
        cars: ReadonlyMap<string, CarObservation>;
    }): void {
        const { chargers, nowMs, links, cars } = params;
        for (const charger of chargers) {
            const active = links.get(charger.id);
            if (active) this.lingering.delete(charger.id);
            const link = active ?? this.liveLingeringLink(charger.id, links, nowMs);
            const car = link ? cars.get(link.carId) : undefined;
            if (!link || !car) continue;
            if (active) this.disproveLimitIfExceeded(charger.id, active, car);
            this.watchCharger(charger, link, car, nowMs);
        }
    }

    private watchCharger(
        charger: EvCarLinkChargerView,
        link: SelfStopLink,
        car: CarObservation,
        nowMs: number,
    ): void {
        // An unavailable power reading is not evidence of idleness — but it is
        // not evidence the episode ENDED either. Treating it as "condition
        // broke" re-armed reporting, so once the same idle telemetry returned
        // and completed another dwell, one uninterrupted physical stop was
        // reported and banked again: enough telemetry gaps manufacture the two
        // samples needed to publish a false observed charge limit from a single
        // session. Hold the dwell and the reported flag; only a RESOLVED
        // reading that fails the classifier ends the episode.
        if (!hasSessionPowerEvidence(charger, link.sinceMs)) return;
        const delivery = this.lastDelivery.get(charger.id);
        const reason = classifyEvCarSelfStop({
            carState: car.state,
            chargerState: charger.evChargingState,
            chargerPowerW: charger.measuredPowerW,
            chargerSwitchOn: charger.controlOn,
            lastDeliveryReadingAtMs: delivery !== undefined && delivery.seenAtMs >= link.sinceMs
                ? delivery.readingAtMs
                : undefined,
            lastStopCommandAtMs: this.lastStopCommandAtMs.get(charger.id),
        });
        // The condition broke: the car resumed, PELS stopped the charger, or
        // real draw returned. Reset the dwell clock so the next episode is timed
        // from its own start, and re-arm reporting. A lingering link goes once
        // its car disconnects; until then the car may still be catching up.
        if (reason === null) {
            this.selfStopSince.delete(charger.id);
            this.selfStopReported.delete(charger.id);
            if (!isEvPlugStateConnected(car.state)) this.lingering.delete(charger.id);
            return;
        }
        const heldForMs = nowMs - this.episodeStartMs(charger.id, reason, nowMs);
        if (heldForMs < EV_CAR_LINK_SELF_STOP_MIN_MS) return;
        if (this.selfStopReported.has(charger.id)) return;
        const lingering = this.lingering.get(charger.id);
        if (lingering && nowMs - lingering.endedAtMs < EV_CAR_LINK_LINGER_CONFIRM_MS) return;

        this.selfStopReported.add(charger.id);
        this.lingering.delete(charger.id);
        this.emitSelfStop({
            charger, link, car, reason, heldForMs, nowMs, chargerPowerW: charger.measuredPowerW,
        });
    }

    private liveLingeringLink(
        chargerId: string,
        links: ReadonlyMap<string, SelfStopLink>,
        nowMs: number,
    ): SelfStopLink | undefined {
        const link = this.lingering.get(chargerId);
        if (link === undefined) return undefined;
        const linkedElsewhere = [...links.values()].some((active) => active.carId === link.carId);
        if (!linkedElsewhere && nowMs - link.endedAtMs <= EV_CAR_LINK_LINGER_MAX_MS) return link;
        this.lingering.delete(chargerId);
        return undefined;
    }

    /**
     * A car charging past the limit its stops had qualified proves that limit
     * was not the car's: the stops were something else (an owner unplugging, a
     * charger fault) that happened to agree, or the owner raised the limit. Its
     * samples are dropped so the limit is learned again from stops still to come.
     *
     * Only a climb seen HERE counts: the car must be charging on this charger,
     * having been at or below the limit earlier in the same session. A car that
     * arrives above its home limit (fast-charged on a trip) proves nothing about
     * where it stops at home.
     */
    private disproveLimitIfExceeded(chargerId: string, link: SelfStopLink, car: CarObservation): void {
        if (car.socPct === undefined || car.socAtMs < link.sinceMs) return;
        const snapshot = this.deps.getSnapshot();
        const chargeLimitPct = resolveEvCarChargeLimit(snapshot, link.carId);
        if (chargeLimitPct === null) return;
        if (car.socPct <= chargeLimitPct + EV_CAR_LINK_LIMIT_DISPROOF_MARGIN_PCT) {
            this.sawCarWithinLimit.add(chargerId);
            return;
        }
        if (car.state !== 'plugged_in_charging' || !this.sawCarWithinLimit.has(chargerId)) return;
        this.sawCarWithinLimit.delete(chargerId);
        this.deps.setSnapshot(clearEvCarObservedStops(snapshot, link.carId));
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_observed_limit_disproven',
            carId: link.carId,
            carName: car.name,
            chargerId,
            chargeLimitPct,
            socPct: car.socPct,
        });
    }

    /**
     * When the CURRENT self-stop episode began. A change of reason starts a new
     * episode and re-arms reporting: both reasons are non-null, so reusing the
     * previous start time would let a two-minute `car_schedule_hold` that flips
     * to `plugged_in` report `car_not_charging` immediately — and bank the charge
     * as observed-limit evidence for a condition that held for seconds.
     */
    private episodeStartMs(chargerId: string, reason: EvCarSelfStopReason, nowMs: number): number {
        const episode = this.selfStopSince.get(chargerId);
        if (episode?.reason === reason) return episode.sinceMs;
        this.selfStopSince.set(chargerId, { sinceMs: nowMs, reason });
        this.selfStopReported.delete(chargerId);
        return nowMs;
    }


    private emitSelfStop(params: {
        charger: EvCarLinkChargerView;
        link: SelfStopLink;
        car: CarObservation;
        reason: EvCarSelfStopReason;
        heldForMs: number;
        nowMs: number;
        chargerPowerW: number;
    }): void {
        const { charger, link, car, reason, heldForMs, nowMs, chargerPowerW } = params;
        // Only limit-LIKE stops feed the charge-limit statistic. A smart-charging
        // schedule pauses at whatever percentage the schedule says, so two such
        // holds would clear the two-sample threshold and publish a confident
        // `observedLimitPct` that is not a limit at all.
        //
        // The charge must also belong to THIS session. `mergeCarObservation`
        // deliberately carries a last-known percentage forward when later updates
        // omit or malform `measure_battery`, so without the currency check a
        // reading from an earlier session is banked as where the car stopped in
        // this one — and two such episodes publish a confidently wrong limit.
        const socIsCurrent = car.socAtMs >= link.sinceMs;
        if (car.socPct !== undefined && socIsCurrent && reason === 'car_not_charging') {
            this.deps.setSnapshot(recordEvCarSelfStopSoc({
                snapshot: this.deps.getSnapshot(),
                carId: link.carId,
                socPct: car.socPct,
                nowMs,
            }));
        }
        const snapshot = this.deps.getSnapshot();
        const limit = summarizeEvCarObservedLimit(snapshot, link.carId);
        const chargeLimitPct = resolveEvCarChargeLimit(snapshot, link.carId);
        this.deps.emit({
            component: 'devices',
            event: 'ev_car_self_stopped',
            carId: link.carId,
            carName: car.name,
            chargerId: charger.id,
            chargerName: charger.name,
            subReason: reason,
            // Same currency gate as the sample above: a percentage carried over
            // from an earlier session would otherwise be reported as where the
            // car stopped in THIS one — a number it never observed here.
            ...(car.socPct === undefined || !socIsCurrent ? {} : { stoppedAtSocPct: car.socPct }),
            chargerState: charger.evChargingState,
            chargerPowerW,
            heldForMs,
            ...(limit === null ? {} : {
                observedLimitPct: limit.medianPct,
                observedLimitSpreadPct: limit.spreadPct,
            }),
            observedLimitSamples: limit?.sampleCount ?? 0,
            ...(chargeLimitPct === null ? {} : { chargeLimitPct }),
        });
    }
}
