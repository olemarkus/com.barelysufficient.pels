/**
 * The cars the EV car-link probe tracks, each in exactly one state.
 *
 * A car is either OBSERVED, holding a readable plug state and taking part in
 * correlation, or UNOBSERVED: Homey reports it, but PELS holds no observation of
 * it. An unobserved car is never offered to correlation; it is kept so the
 * targeted refresh keeps requesting it and sees it recover. It is unobserved for
 * one of two reasons:
 *
 * - `outage`: Homey marked the car unavailable, and it has not reported a
 *   readable plug state since, even if it is available again. The outage
 *   suspended its session, which a charger disconnect may still disprove.
 * - `unread`: Homey reports the car, but it has never reported a readable plug
 *   state.
 *
 * Every transition goes through this class, and each one moves the car out of
 * the state it was in. The probe used to keep one hand-maintained collection
 * per state, and a car that came back from unavailable with no readable plug
 * state sat in two of them: the targeted refresh then requested it twice and
 * counted two misses per read.
 */
import type { CarObservation } from './evCarLinkObservation';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';

type UnobservedCar = { reason: 'outage' | 'unread'; name: string };

export class EvCarLinkRoster {
    private readonly observedCars = new Map<string, CarObservation>();
    private readonly unobservedCars = new Map<string, UnobservedCar>();
    /** Arrival of the first connected observation in this car's current session. */
    private readonly connectedSinceMs = new Map<string, number>();

    /** The observed cars: the only ones correlation sees. */
    get observed(): ReadonlyMap<string, CarObservation> {
        return this.observedCars;
    }

    /** Every tracked car, each once, for the targeted refresh to request. */
    ids(): string[] {
        return [...this.observedCars.keys(), ...this.unobservedCars.keys()];
    }

    /**
     * Whether a realtime pass has anything to correlate: a car is observed, or
     * one is in an outage and a charger disconnect may disprove its suspended
     * session. A car that has never read gives a pass nothing to do, and a pass
     * would consume the charger's plug edge before the refresh that first reads
     * the car could pair it.
     */
    needsCorrelation(): boolean {
        if (this.observedCars.size > 0) return true;
        for (const car of this.unobservedCars.values()) {
            if (car.reason === 'outage') return true;
        }
        return false;
    }

    /** Which state a car is in; `undefined` when it is not tracked at all. */
    status(carId: string):
        { kind: 'observed'; observation: CarObservation } | ({ kind: 'unobserved' } & UnobservedCar) | undefined {
        const observation = this.observedCars.get(carId);
        if (observation) return { kind: 'observed', observation };
        const unobserved = this.unobservedCars.get(carId);
        return unobserved ? { kind: 'unobserved', ...unobserved } : undefined;
    }

    name(carId: string): string | undefined {
        return this.observedCars.get(carId)?.name ?? this.unobservedCars.get(carId)?.name;
    }

    observe(carId: string, observation: CarObservation, nowMs: number): void {
        if (!isEvPlugStateConnected(observation.state)) this.connectedSinceMs.delete(carId);
        else if (!this.connectedSinceMs.has(carId)) this.connectedSinceMs.set(carId, nowMs);
        this.unobservedCars.delete(carId);
        this.observedCars.set(carId, observation);
    }

    /** The observed cars reporting plugged in, in roster order. */
    connectedCarIds(): string[] {
        return [...this.observedCars].flatMap(([carId, car]) => (isEvPlugStateConnected(car.state) ? [carId] : []));
    }

    /** Source timestamps cannot backdate evidence that first arrived after a match deadline. */
    wasConnectedBy(carId: string, deadlineMs: number): boolean {
        const sinceMs = this.connectedSinceMs.get(carId);
        return sinceMs !== undefined && sinceMs <= deadlineMs;
    }

    markUnavailable(carId: string, name: string): void {
        this.connectedSinceMs.delete(carId);
        this.observedCars.delete(carId);
        this.unobservedCars.set(carId, { reason: 'outage', name });
    }

    /** Homey reports the car with no readable plug state; an outage lasts until one reads. */
    markUnread(carId: string, name: string): void {
        this.connectedSinceMs.delete(carId);
        const reason = this.unobservedCars.get(carId)?.reason ?? 'unread';
        this.observedCars.delete(carId);
        this.unobservedCars.set(carId, { reason, name });
    }

    forget(carId: string): void {
        this.connectedSinceMs.delete(carId);
        this.observedCars.delete(carId);
        this.unobservedCars.delete(carId);
    }
}
