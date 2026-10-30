/**
 * The rules for which car a charger's link may hold. Mostly the provisional
 * link: the one car a charger's unsettled plug-in pairs with, linked before the
 * rival window has closed so its battery level reaches the charger at once. Also
 * what bars past matches from a car, and which other links a new one ends. See
 * `correlate` in `evCarLinkProducer.ts`; split out to keep that file within its
 * size ceiling.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import { EV_CAR_LINK_COINCIDENCE_WINDOW_MS, type EvLinkCoincidence, type EvLinkResolution } from './evCarLink';
import type { ActiveLinkView } from './evCarLinkReadModel';
import type { EvCarLinkRoster } from './evCarLinkRoster';

type Link = ActiveLinkView & { provisional: boolean };

/**
 * Whether `pairing` may take its charger now. Never over a final link, never for
 * a car that already holds a link elsewhere, and not again for the same pairing;
 * an older provisional link for the charger (a bouncing plug moved the resting
 * edge) is replaced.
 */
export const mayOpenProvisionalLink = (
    activeLinks: ReadonlyMap<string, Link>,
    pairing: EvLinkCoincidence,
): boolean => {
    if (pairing.kind !== 'connect') return false;
    const existing = activeLinks.get(pairing.chargerId);
    if (existing && (!existing.provisional
        || (existing.carId === pairing.carId && existing.sinceMs === pairing.atMs))) return false;
    for (const [chargerId, link] of activeLinks) {
        if (chargerId !== pairing.chargerId && link.carId === pairing.carId) return false;
    }
    return true;
};

/**
 * Why past matches may not give their pick the connection that began at
 * `sessionStartedAtMs`, or `null` when they may or did not pick it:
 * - `car_reported_too_late`: the car's connection first reached PELS after this
 *   connection's window closed, so it could have plugged in anywhere meanwhile
 *   (owner, 2026-10-25). It still counts as a rival, since it may be the car on
 *   this charger.
 * - `car_linked_elsewhere`: another charger that still reports plugged in
 *   holds it, by a plug-in, a match or a session resumed after a restart. That
 *   is better evidence of where the car is than this charger's history, and a
 *   charger found plugged in at start dates its connection from PELS starting,
 *   so the age of the two links says nothing. A link at a charger now reporting
 *   unplugged is a disconnect PELS missed, which this session supersedes.
 */
export const resolvePastMatchRefusal = (
    cars: Pick<EvCarLinkRoster, 'wasConnectedBy'>,
    activeLinks: ReadonlyMap<string, Link>,
    chargerStates: ReadonlyMap<string, EvChargingState>,
    chargerId: string,
    resolution: EvLinkResolution,
    sessionStartedAtMs: number,
): 'car_reported_too_late' | 'car_linked_elsewhere' | null => {
    if (resolution.source !== 'affinity_prior') return null;
    const { carId } = resolution;
    if (!cars.wasConnectedBy(carId, sessionStartedAtMs + EV_CAR_LINK_COINCIDENCE_WINDOW_MS)) {
        return 'car_reported_too_late';
    }
    const linkedElsewhere = [...activeLinks].some(([otherChargerId, link]) => {
        const otherState = chargerStates.get(otherChargerId);
        return otherChargerId !== chargerId && link.carId === carId
            && otherState !== undefined && isEvPlugStateConnected(otherState);
    });
    return linkedElsewhere ? 'car_linked_elsewhere' : null;
};

/** The other chargers `carId` is linked at, collected before any is cleared. */
export const findOtherLinksTo = (
    activeLinks: ReadonlyMap<string, Link>,
    chargerId: string,
    carId: string,
): string[] => [...activeLinks].flatMap(([otherChargerId, link]) => (
    otherChargerId !== chargerId && link.carId === carId ? [otherChargerId] : []
));

/** Whether a charger holds `carId` now: confirmed, linked, resumed or provisional. */
export const holdsCar = (activeLinks: ReadonlyMap<string, { carId: string }>, carId: string): boolean => (
    [...activeLinks.values()].some((link) => link.carId === carId)
);

/** Chargers whose provisional link no longer matches a current pairing for that charger, car and plug-in. */
export const findUnsupportedProvisionalLinks = (
    activeLinks: ReadonlyMap<string, Link>,
    pairings: readonly EvLinkCoincidence[],
): string[] => [...activeLinks].flatMap(([chargerId, link]) => (
    link.provisional && !pairings.some((pairing) => (
        pairing.chargerId === chargerId && pairing.carId === link.carId && pairing.atMs === link.sinceMs
    ))
        ? [chargerId] : []
));

/**
 * The links that are final. Self-stop evidence (stop samples, an observed charge
 * limit, a disproved limit) is persisted, so a provisional link that a rival may
 * still withdraw must not produce any.
 */
export const finalLinks = <T extends Link>(activeLinks: ReadonlyMap<string, T>): Map<string, T> => new Map(
    [...activeLinks].filter(([, link]) => !link.provisional),
);
