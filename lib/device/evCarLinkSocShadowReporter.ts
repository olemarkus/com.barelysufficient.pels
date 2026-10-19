/** Reports observed car battery changes against the charger serving that session. */
import type { EvCarLinkProducerDeps } from './evCarLinkProducer';
import type { EvCarSelfStopWatcher } from './evCarLinkSelfStop';
import { hasSessionPowerEvidence, type EvCarLinkChargerView } from './evCarLinkChargerView';
import { isChargingElsewhere } from './evCarLink';
import { resolveEvCarChargeLimit } from './evCarLinkSnapshot';

/** A car's charge reading held until its charger link resolves. */
export type PendingSocShadow = { previousSocPct?: number; socPct: number; socAtMs: number };

export class EvCarLinkSocShadowReporter {
    constructor(
        private readonly deps: EvCarLinkProducerDeps,
        private readonly selfStop: EvCarSelfStopWatcher,
        private readonly carName: (carId: string) => string,
    ) {}

    emit(
        carId: string,
        charger: EvCarLinkChargerView,
        reading: PendingSocShadow,
        sessionStartedAtMs: number,
    ): void {
        const { previousSocPct, socPct, socAtMs } = reading;
        const carName = this.carName(carId);
        const idleSinceMs = this.selfStop.chargerIdleSinceMs(charger.id);
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
            chargeLimitPct: resolveEvCarChargeLimit(this.deps.getSnapshot(), carId),
        });
    }

}
