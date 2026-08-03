import type { EvCarLinkSession } from '../../packages/contracts/src/evCarLink';
import type { CarObservation } from './evCarLinkObservation';
import type { EvCarLinkChargerView } from './evCarLinkChargerView';
import { isEvConnectedState } from './evCarLink';

/**
 * Deciding which sessions a restart may pick back up.
 *
 * A restart observes no plug-in — the plug-in already happened — so without this
 * a charger that was mid-charge has no car until the next physical unplug and
 * replug, which can be the whole session. Pure so the rule is testable without a
 * producer; the producer applies whatever this returns.
 *
 * Design of record: `notes/ev-car-link/README.md`.
 */

export type ResumableSession = {
    chargerId: string;
    carId: string;
    /** The ORIGINAL session start, carried across the outage. */
    sinceMs: number;
};

/**
 * The persisted pair says who the car WAS; both sides reporting connected now is
 * what makes it who it IS. Neither half suffices alone: a car plugged in at work
 * reports connected exactly like one plugged in here, and a charger reports
 * connected whichever car is on it.
 *
 * Known and accepted: a car swapped for another DURING the outage resumes the
 * wrong car. That needs an outage long enough for one car to leave and another
 * to arrive, and it self-corrects on the next unplug. The conservative
 * alternative — refuse whenever another car is also connected — would break the
 * ordinary two-car, two-charger household on every restart, a far commoner case
 * than the one it guards against.
 */
export const resolveResumableSessions = (params: {
    sessions: Readonly<Record<string, EvCarLinkSession>> | undefined;
    chargers: readonly EvCarLinkChargerView[];
    cars: ReadonlyMap<string, CarObservation>;
    /** Chargers that already hold a live link, or were already resumed this run. */
    isSettled: (chargerId: string) => boolean;
}): ResumableSession[] => {
    const { sessions, chargers, cars, isSettled } = params;
    if (!sessions) return [];
    const resumable: ResumableSession[] = [];
    for (const charger of chargers) {
        if (isSettled(charger.id)) continue;
        const session = sessions[charger.id];
        if (!session) continue;
        if (!isEvConnectedState(charger.evChargingState)) continue;
        const car = cars.get(session.carId);
        if (!car || !isEvConnectedState(car.state)) continue;
        resumable.push({ chargerId: charger.id, carId: session.carId, sinceMs: session.sinceMs });
    }
    return resumable;
};
