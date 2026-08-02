import type { AssociatedCarSnapshot } from '../../../packages/contracts/src/types';
import type { DeviceTransportParseProviders } from './managerParseDevice';
import type { TransportEvCarLinkProducer } from './transportContext';

/**
 * Exactly the two reads this resolver performs — declared rather than taking the
 * whole `TransportContext`, so the contract is visible and a test can satisfy it
 * with a real typed value instead of a cast. `TransportContext` satisfies it
 * structurally.
 */
export type CarAssociationSources = {
  providers: Pick<DeviceTransportParseProviders, 'getEvCarAssociationCarIds'>;
  observationProducers: {
    evCarLink: Pick<TransportEvCarLinkProducer, 'getAssociatedCarForCharger'>;
  };
};

/**
 * The single resolver for "which car is associated with this charger right now".
 *
 * Two independent facts have to agree, and they are owned by different layers:
 *
 * - the **probe** decides which car matched this charger's plug edge
 *   (`evCarLinkProducer`), knowing nothing about user configuration;
 * - the **user** decides which cars this charger may associate at all, which
 *   reaches the device layer as a plain id list on the parse providers.
 *
 * Eligibility narrows the candidates; it does not stand in for the evidence. A
 * ticked car still has to match a plug edge, because a car plugged in at work
 * reports exactly the same connected state as one on this charger — that is what
 * `ev_car_session_elsewhere` exists to report, and prod logged 357 of them in
 * three days.
 *
 * Resolved on every read rather than stamped onto the charger's snapshot. The
 * association changes when the probe's session changes — which happens on the
 * realtime feed, seconds after a plug edge — while snapshots are only rebuilt at
 * :25 and :55 and are wholly replaced by every device re-parse. A stored copy
 * would therefore be absent most of the time and wrong for up to half an hour
 * after unplugging. Recomputing costs two map lookups.
 */
export const resolveAssociatedCar = (
  ctx: CarAssociationSources,
  chargerId: string,
): AssociatedCarSnapshot | undefined => {
  const eligibleCarIds = ctx.providers.getEvCarAssociationCarIds?.(chargerId) ?? [];
  if (eligibleCarIds.length === 0) return undefined;
  const associated = ctx.observationProducers.evCarLink.getAssociatedCarForCharger(chargerId);
  if (!associated) return undefined;
  return eligibleCarIds.includes(associated.carId) ? associated : undefined;
};
