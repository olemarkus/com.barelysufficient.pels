/**
 * What the car-link probe says about plug-ins and about a charger that waited
 * for a car: plug edges, the cars a charger waited for, the timeout, and a car
 * that reported its plug-in too late to pair by timing. Reports only; nothing
 * here links a car.
 *
 * Split from `evCarLinkProducer.ts`, which decides, so that file stays within
 * its size ceiling; this says what it decided and observed.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import type { CarLinkCarStatus, CarLinkConnection } from '../ports/carLinkDiagnostics';
import { EV_CAR_LINK_COINCIDENCE_WINDOW_MS, type EvLinkEdgeKind } from './evCarLink';
import { admitsCar, type EvCarLinkChargerView } from './evCarLinkChargerView';
import type { EvCarLinkEvent, EvLinkUnmatchedReason } from './evCarLinkEvents';
import type { CarObservation } from './evCarLinkObservation';
import type { EvCarLinkRoster } from './evCarLinkRoster';
import { getEvCarLinkVotes } from './evCarLinkSnapshot';

export class EvCarLinkWaitReporter {
    /** Chargers whose current connection PELS found already plugged in when it started. */
    private readonly connectedAtStart = new Set<string>();

    constructor(
        private readonly emit: (event: EvCarLinkEvent) => void,
        private readonly cars: EvCarLinkRoster,
        private readonly getSnapshot: () => EvCarLinkSnapshot,
        private readonly getChargers: () => readonly EvCarLinkChargerView[],
        /** When each plugged-in charger's connection started, as the probe saw it. */
        private readonly connectedAtMsByCharger: ReadonlyMap<string, number>,
        /** Whether a charger has a car for its current connection, linked or confirmed. */
        private readonly hasCar: (chargerId: string) => boolean,
    ) {}

    /** When the probe saw this charger's current connection start; absent when it is not plugged in. */
    connection(chargerId: string): CarLinkConnection | undefined {
        const atMs = this.connectedAtMsByCharger.get(chargerId);
        if (atMs === undefined) return undefined;
        return { atMs, seen: this.connectedAtStart.has(chargerId) ? 'already_plugged_in_at_start' : 'plug_in' };
    }

    /** The cars that may pair with a charger: its selected cars, or every car the probe tracks. */
    carIdsFor(charger: EvCarLinkChargerView): readonly string[] {
        return charger.selectedCarIds.length > 0 ? charger.selectedCarIds : this.cars.ids();
    }

    /** These cars as the probe holds them, with their past matches to `chargerId`. */
    describeCars(chargerId: string, carIds: readonly string[]): CarLinkCarStatus[] {
        const snapshot = this.getSnapshot();
        return [...new Set(carIds)].map((carId): CarLinkCarStatus => {
            const status = this.cars.status(carId);
            const pastMatches = getEvCarLinkVotes(snapshot, carId, chargerId);
            if (!status) return { availability: 'unknown', carId, pastMatches };
            if (status.kind === 'unobserved') {
                return { availability: status.reason, carId, carName: status.name, pastMatches };
            }
            return {
                availability: 'observed',
                carId,
                carName: status.observation.name,
                state: status.observation.state,
                stateReportedAtMs: status.observation.stateAtMs,
                pastMatches,
            };
        });
    }

    /** A charger PELS found already plugged in when it started; its connection time is the start. */
    chargerConnectedAtStart(chargerId: string): void {
        this.connectedAtStart.add(chargerId);
    }

    chargerEdge(charger: EvCarLinkChargerView, kind: EvLinkEdgeKind, state: EvChargingState): void {
        this.connectedAtStart.delete(charger.id);
        this.emit({
            component: 'devices', event: 'ev_car_link_plug_edge', role: 'charger',
            deviceId: charger.id, deviceName: charger.name, kind, state,
        });
    }

    /**
     * A car's plug edge, and on a plug-in, a late report for each charger the
     * car may pair with that has been plugged in with no car for longer than the
     * window. It may be the car on that charger, reported late, or a car that
     * plugged in somewhere else meanwhile.
     */
    carEdge(carId: string, observation: CarObservation, kind: EvLinkEdgeKind, nowMs: number): void {
        this.emit({
            component: 'devices', event: 'ev_car_link_plug_edge', role: 'car',
            deviceId: carId, deviceName: observation.name, kind, state: observation.state,
            reportedAtMs: observation.stateAtMs,
        });
        if (kind !== 'connect') return;
        for (const charger of this.getChargers()) {
            const connection = this.connection(charger.id);
            if (!connection || nowMs - connection.atMs <= EV_CAR_LINK_COINCIDENCE_WINDOW_MS) continue;
            if (!admitsCar(charger, carId) || !isEvPlugStateConnected(charger.evChargingState)) continue;
            if (this.hasCar(charger.id)) continue;
            this.emit({
                component: 'devices',
                event: 'ev_car_link_late_car_report',
                chargerId: charger.id,
                chargerName: charger.name,
                carId,
                carName: observation.name,
                connection,
                lateByMs: nowMs - connection.atMs,
            });
        }
    }

    /**
     * The timeout: what the charger waited for, and why it got no car. `weighed`
     * are the plugged-in cars the past-match decision looked at, which need not
     * be the charger's selected cars.
     */
    unmatched(charger: EvCarLinkChargerView, reason: EvLinkUnmatchedReason, weighed: readonly string[]): void {
        const connection = this.connection(charger.id);
        if (!connection) return;
        this.emit({
            component: 'devices',
            event: 'ev_car_link_unmatched',
            chargerId: charger.id,
            chargerName: charger.name,
            connection,
            windowMs: EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
            reason,
            cars: this.describeCars(charger.id, [...this.carIdsFor(charger), ...weighed]),
        });
    }
}
