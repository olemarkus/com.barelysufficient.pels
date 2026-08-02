import type { AssociatedCarSnapshot } from '../../packages/contracts/src/types';
import type { CarObservation } from './evCarLinkObservation';

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
 * Staleness is therefore the consumer's rendering concern (how old is this
 * reading) and, when the level is adopted as the charger's state-of-charge, the
 * established `resolveStateOfChargeStatus` rule applies — age decays it only
 * while charge is actually in motion.
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

    return {
        carId: link.carId,
        carName: car.name,
        chargingState: car.state,
        // Absent until the car has reported a valid charge at least once —
        // omitted, never a fabricated zero, which would read as an empty battery.
        ...(car.socPct === undefined ? {} : { socPct: car.socPct, socObservedAtMs: car.socAtMs }),
    };
};
