/** Reports observed car battery changes against the charger serving that session. */
import type { EvCarLinkProducerDeps } from './evCarLinkProducer';
import type { EvCarSelfStopWatcher } from './evCarLinkSelfStop';
import { hasSessionPowerEvidence, type EvCarLinkChargerView } from './evCarLinkChargerView';
import { isChargingElsewhere } from './evCarLink';
import { resolveEvCarChargeLimit } from './evCarLinkSnapshot';

/** A car's charge reading held until its charger link resolves. */
export type PendingSocShadow = { socPct: number; socAtMs: number };

/** The lowest charge a car read during one idle period of the charger it is linked to. */
type IdleChargeLow = { chargerId: string; idleSinceMs: number; socPct: number };

export class EvCarLinkSocShadowReporter {
    /** Charge readings awaiting link resolution, by car. */
    private readonly pending = new Map<string, PendingSocShadow>();
    /**
     * The session each car was last reported charging elsewhere in, by car: the
     * verdict is about the session, so it is said once, not with every reading.
     * One entry per car, replaced by its next session.
     */
    private readonly reportedElsewhere = new Map<string, number>();
    /** Each car's lowest charge since its charger went idle, by car. */
    private readonly idleLows = new Map<string, IdleChargeLow>();
    /**
     * The whole percent each car's shadow line last reported, by car. A car that
     * reports tenths would otherwise log a line every tenth it charges.
     */
    private readonly loggedWholePct = new Map<string, number>();

    constructor(
        private readonly deps: EvCarLinkProducerDeps,
        private readonly selfStop: EvCarSelfStopWatcher,
        private readonly carName: (carId: string) => string,
    ) {}

    /** Holds a car's newest charge reading until its link resolves, replacing any older one. */
    hold(carId: string, reading: PendingSocShadow): void {
        this.pending.set(carId, reading);
    }

    /**
     * Forgets what a car's readings built up while it cannot be read. Its session
     * is kept for recovery, and so is that session's verdict: the same session
     * coming back must not be reported charging elsewhere twice.
     */
    suspend(carId: string): void {
        this.pending.delete(carId);
        this.idleLows.delete(carId);
        this.loggedWholePct.delete(carId);
    }

    /** Forgets everything about a car: it can no longer be reported against a charger. */
    drop(carId: string): void {
        this.suspend(carId);
        this.reportedElsewhere.delete(carId);
    }

    /** Reports each held reading against the chargers its car is linked to now, then drops it. */
    flush(
        chargers: readonly EvCarLinkChargerView[],
        links: ReadonlyMap<string, { carId: string; sinceMs: number }>,
    ): void {
        if (this.pending.size === 0) return;
        const pending = [...this.pending];
        this.pending.clear();
        for (const [carId, reading] of pending) {
            for (const [chargerId, link] of links) {
                if (link.carId !== carId) continue;
                const charger = chargers.find((entry) => entry.id === chargerId);
                if (charger) this.emit(carId, charger, reading, link.sinceMs);
            }
        }
    }

    emit(
        carId: string,
        charger: EvCarLinkChargerView,
        reading: PendingSocShadow,
        sessionStartedAtMs: number,
    ): void {
        const { socPct } = reading;
        const carName = this.carName(carId);
        if (
            this.reportedElsewhere.get(carId) !== sessionStartedAtMs
            // The idle reading must belong to THIS session. A charger that
            // reconnects carrying a retained idle value from the previous one is
            // not evidence it is delivering nothing now, and a charge rise while
            // it genuinely charges at home would be logged as an away session.
            && hasSessionPowerEvidence(charger, sessionStartedAtMs)
            && this.chargedWhileIdle(carId, charger, reading)
        ) {
            this.reportedElsewhere.set(carId, sessionStartedAtMs);
            this.deps.emit({
                component: 'devices',
                event: 'ev_car_session_elsewhere',
                carId,
                carName,
                reason: 'charger_idle_while_soc_rising',
            });
        }
        const wholePct = Math.floor(socPct);
        if (this.loggedWholePct.get(carId) !== wholePct || charger.reportedSocPct !== undefined) {
            this.loggedWholePct.set(carId, wholePct);
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
        }
        this.deps.onAssociatedCarStateOfCharge?.({
            chargerId: charger.id,
            carId,
            socPct,
            socAtMs: reading.socAtMs,
            chargeLimitPct: resolveEvCarChargeLimit(this.deps.getSnapshot(), carId),
        });
    }

    /**
     * Whether this reading rose far enough above the car's lowest reading since
     * the charger went idle, recording the reading as that low when it is one.
     * A reading taken before the idle start, or the first of an idle period,
     * starts no rise: a rise from a reading the charger still delivered toward
     * may be that charger's own.
     */
    private chargedWhileIdle(
        carId: string,
        charger: EvCarLinkChargerView & { measuredPowerW: number },
        reading: PendingSocShadow,
    ): boolean {
        const idleSinceMs = this.selfStop.chargerIdleSinceMs(charger.id);
        if (idleSinceMs === undefined || reading.socAtMs < idleSinceMs) return false;
        const low = this.idleLows.get(carId);
        if (!low || low.chargerId !== charger.id || low.idleSinceMs !== idleSinceMs) {
            this.idleLows.set(carId, { chargerId: charger.id, idleSinceMs, socPct: reading.socPct });
            return false;
        }
        if (reading.socPct < low.socPct) this.idleLows.set(carId, { ...low, socPct: reading.socPct });
        return isChargingElsewhere({
            lowestIdleSocPct: low.socPct,
            currentSocPct: reading.socPct,
            chargerPowerW: charger.measuredPowerW,
        });
    }
}
