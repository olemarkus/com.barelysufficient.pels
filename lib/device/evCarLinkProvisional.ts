/**
 * The rules for a provisional car-to-charger link: the one car a charger's
 * unsettled plug-in pairs with, linked before the rival window has closed so its
 * battery level reaches the charger at once. See `correlate` in
 * `evCarLinkProducer.ts`; split out to keep that file within its size ceiling.
 */
import type { EvLinkCoincidence } from './evCarLink';
import type { ActiveLinkView } from './evCarLinkReadModel';

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
