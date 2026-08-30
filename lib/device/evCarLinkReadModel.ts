import type { AssociatedCarSnapshot } from '../../packages/contracts/src/types';
import type { CarObservation } from './evCarLinkObservation';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';

/**
 * Resolves the car-link probe's in-memory session state into the flat,
 * consumer-facing shape. Lives outside `evCarLinkProducer.ts` to keep that file
 * within the 500-LOC budget, and pure so the currency rule below is unit
 * testable without a producer.
 *
 * Design of record: `notes/ev-car-link/README.md`.
 */

/** The producer's per-charger session record, narrowed to what resolution needs. */
export type ActiveLinkView = {
    carId: string;
    /** When the session was committed. Not used to gate the charge reading — see
     *  the note on `resolveAssociatedCarSnapshot` — but it identifies the session
     *  and is what `emitSelfStop` measures its per-session evidence against. */
    sinceMs: number;
};

/**
 * The car associated with `chargerId` right now, or `undefined` when the charger
 * has no session.
 *
 * The charge percentage is served with its observation time and is NOT gated on
 * the session start. A battery level observed before the car plugged in is still
 * the car's real charge — a parked battery does not move, and cars publish
 * `measure_battery` on change, so most sessions begin with the last pre-plug
 * reading and nothing new arrives until the level actually rises. Suppressing it
 * would blank the level for exactly the cars that report correctly, and it is
 * the same mistake as ageing out a quiet charger's `measure_battery`, which
 * pinned a smart task at `objective_progress_stale` for a night in prod
 * (`lib/device/AGENTS.md`, 2026-07-26).
 *
 * `emitSelfStop` keeps its stricter `socIsCurrent` gate because it asks a
 * different question — "where did the car stop THIS time" is a per-session
 * statistic, and banking a previous session's percentage there publishes a
 * confidently wrong charge limit.
 *
 * Age is therefore the consumer's rendering concern and nothing else. Nothing
 * decays a level: when it is adopted as the charger's state-of-charge, the
 * session decides whether PELS has one (`resolveStateOfChargeSnapshot`,
 * `lib/device/transport/stateOfCharge.ts`), and the
 * car's own plug state is what ends that session — which is why an association
 * is not resolved at all for a car that reports itself disconnected.
 */
export const resolveAssociatedCarSnapshot = (params: {
    cars: ReadonlyMap<string, CarObservation>;
    links: ReadonlyMap<string, ActiveLinkView>;
    chargerId: string;
}): AssociatedCarSnapshot | undefined => {
    const { cars, links, chargerId } = params;
    const link = links.get(chargerId);
    if (!link) return undefined;
    const car = cars.get(link.carId);
    if (!car) return undefined;
    // The car's own plug state is the guard, resolved HERE so no consumer has to
    // ask: an `AssociatedCarSnapshot` cannot exist for a car that has left, and
    // the charger's adopted level goes with it. The session paths normally get
    // there first — a disconnect edge clears the session immediately
    // (`applyCarObservation`), resume forgets one whose car reads disconnected,
    // and the affinity fallback only considers connected cars — but each of
    // those needs a prior observation to compare against, and this does not.
    if (!isEvPlugStateConnected(car.state)) return undefined;

    return {
        carId: link.carId,
        carName: car.name,
        chargingState: car.state,
        chargingStateObservedAtMs: car.stateAtMs,
        // Absent until the car has reported a valid charge at least once —
        // omitted, never a fabricated zero, which would read as an empty battery.
        ...(car.socPct === undefined ? {} : { socPct: car.socPct, socObservedAtMs: car.socAtMs }),
    };
};

/**
 * Every associated charger's current car battery level.
 *
 * The level is a value the probe holds continuously, not an event: a car sitting
 * at 40 % publishes nothing, and one whose level moved while PELS was down has
 * already sent its update. Serving it from the association rather than from a
 * change notification is what lets an associated charger always have a level.
 */
export const collectAssociatedCarLevels = (params: {
    cars: ReadonlyMap<string, CarObservation>;
    links: ReadonlyMap<string, ActiveLinkView>;
}): Array<{ chargerId: string; carId: string; socPct: number; socAtMs: number }> => {
    const readings: Array<{ chargerId: string; carId: string; socPct: number; socAtMs: number }> = [];
    for (const [chargerId, link] of params.links) {
        const car = params.cars.get(link.carId);
        if (car?.socPct === undefined) continue;
        readings.push({ chargerId, carId: link.carId, socPct: car.socPct, socAtMs: car.socAtMs });
    }
    return readings;
};
