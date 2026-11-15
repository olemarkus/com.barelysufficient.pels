import type { EvCarLinkEventEmitter, EvCarLinkProducer } from '../evCarLinkProducer';
import type { DeviceParseSettings } from './managerParseDevice';
import type { TransportSnapshotStore } from './transportSnapshotStore';

/**
 * The owner's standing car for a charger (`assumedCarId` in
 * `ev_car_associations`), confirmed once per plug-in through the same path as
 * the confirm button. Each plug-in is settled once, by a confirmation or a
 * cleared one: after the owner clears it, or confirms another car, that
 * plug-in is theirs. A charger found plugged in when PELS started is never
 * due: its confirmed session resumes by itself, and one the owner cleared
 * stays cleared. A car PELS cannot read now, or one another charger still
 * holds (its unplug not reported yet), stays due for a later pass, without a
 * rejected attempt on every pass. An attempt that is made settles the plug-in,
 * confirmed or not, so a rejection is reported once.
 */
export class StandingCarConfirmations {
    private readonly settledAtMs = new Map<string, number>();

    constructor(
        private readonly probe: EvCarLinkProducer,
        private readonly settings: Pick<DeviceParseSettings, 'getEvCarAssumedCarId'>,
        private readonly snapshots: TransportSnapshotStore,
        private readonly emit: EvCarLinkEventEmitter,
    ) {}

    /** The charger's current plug-in is settled; a standing car does not come back for it. */
    settle(chargerId: string): void {
        const connection = this.probe.waitReports.connection(chargerId);
        if (connection) this.settledAtMs.set(chargerId, connection.atMs);
    }

    /** Clearing settles the plug-in too, so the standing car does not come straight back. */
    readonly clear = (chargerId: string): void => {
        this.probe.clearCarConfirmation(chargerId);
        this.settle(chargerId);
    };

    /** Confirms each waiting charger's standing car on a plug-in not yet settled. */
    assume(
        nowMs: number,
        isWaiting: (chargerId: string) => boolean,
        confirm: (chargerId: string, carId: string, nowMs: number) => void,
    ): void {
        for (const charger of this.snapshots.getSnapshot()) {
            const carId = this.settings.getEvCarAssumedCarId(charger.id);
            if (carId === undefined || !isWaiting(charger.id) || !this.isDue(charger.id, carId)) continue;
            this.emit({ component: 'devices', event: 'ev_car_link_assumed', chargerId: charger.id, carId });
            try {
                confirm(charger.id, carId, nowMs);
            } catch {
                // The rejection event says why; the owner can still confirm by hand.
                this.settle(charger.id);
            }
        }
    }

    private isDue(chargerId: string, carId: string): boolean {
        const connection = this.probe.waitReports.connection(chargerId);
        if (!connection || connection.seen !== 'plug_in' || this.settledAtMs.get(chargerId) === connection.atMs) {
            return false;
        }
        return this.probe.waitReports.describeCars(chargerId, [carId])[0]?.availability === 'observed'
            && !this.probe.isCarHeldElsewhere(chargerId, carId);
    }
}
