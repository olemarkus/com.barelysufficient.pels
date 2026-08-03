import type { EvCarLinkChargerView } from './evCarLinkChargerView';
import type { EvCarLinkEvent } from './evCarLinkEvents';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { CarObservation } from './evCarLinkObservation';
import { hasSessionPowerEvidence } from './evCarLinkChargerView';
import {
    EV_CAR_LINK_SELF_STOP_MIN_MS,
    classifyEvCarSelfStop,
    type EvCarSelfStopReason,
} from './evCarLink';
import { recordEvCarSelfStopSoc, summarizeEvCarObservedLimit } from './evCarLinkSnapshot';

/**
 * Detects a car stopping of its OWN accord — at its charge limit, on its own
 * schedule — while the charger still believes it is delivering.
 *
 * Split out of the producer because it owns its own episode bookkeeping and one
 * hard-won rule: an unresolved power reading holds the dwell rather than ending
 * the episode. Getting that wrong manufactures the two samples needed to publish
 * a false observed charge limit from a single physical stop.
 *
 * Design of record: `notes/ev-car-link/README.md`.
 */

/** The session record the watcher reads; the producer owns the live map. */
export type SelfStopLink = { carId: string; sinceMs: number };

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

    constructor(private readonly deps: SelfStopDeps) {}

    /** Drops a charger's episode state when its session ends. */
    forget(chargerId: string): void {
        this.selfStopSince.delete(chargerId);
        this.selfStopReported.delete(chargerId);
    }

    /**
     * Watch each linked charger for the car stopping of its own accord, and for
     * the car's charge climbing while this charger delivers nothing (which proves
     * it is plugged in elsewhere regardless of what the plug edges said).
     */
    watch(params: {
        chargers: readonly EvCarLinkChargerView[];
        nowMs: number;
        links: ReadonlyMap<string, SelfStopLink>;
        cars: ReadonlyMap<string, CarObservation>;
    }): void {
        const { chargers, nowMs, links, cars } = params;
        for (const charger of chargers) {
            const link = links.get(charger.id);
            const car = link ? cars.get(link.carId) : undefined;
            if (!link || !car) continue;

            // An unavailable power reading is not evidence of idleness — but it is
            // not evidence the episode ENDED either. Treating it as "condition
            // broke" re-armed reporting, so once the same idle telemetry returned
            // and completed another dwell, one uninterrupted physical stop was
            // reported and banked again: enough telemetry gaps manufacture the two
            // samples needed to publish a false observed charge limit from a single
            // session. Hold the dwell and the reported flag; only a RESOLVED
            // reading that fails the classifier ends the episode.
            if (!hasSessionPowerEvidence(charger, link.sinceMs)) continue;
            const reason = classifyEvCarSelfStop({
                carState: car.state,
                chargerState: charger.evChargingState,
                chargerControlOn: charger.controlOn,
                chargerPowerW: charger.measuredPowerW,
            });
            // The condition broke: the car resumed, the charger stopped believing
            // it was delivering, or real draw returned. Reset the dwell clock so
            // the next episode is timed from its own start, and re-arm reporting.
            if (reason === null) {
                this.selfStopSince.delete(charger.id);
                this.selfStopReported.delete(charger.id);
                continue;
            }
            const heldForMs = nowMs - this.episodeStartMs(charger.id, reason, nowMs);
            if (heldForMs < EV_CAR_LINK_SELF_STOP_MIN_MS) continue;
            if (this.selfStopReported.has(charger.id)) continue;

            this.selfStopReported.add(charger.id);
            this.emitSelfStop({
                charger, link, car, reason, heldForMs, nowMs, chargerPowerW: charger.measuredPowerW,
            });
        }
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
        const limit = summarizeEvCarObservedLimit(this.deps.getSnapshot(), link.carId);
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
            chargerPowerW,
            heldForMs,
            ...(limit === null ? {} : {
                observedLimitPct: limit.medianPct,
                observedLimitSpreadPct: limit.spreadPct,
            }),
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
}
