import type { AssociatedCarSnapshot } from '../../../packages/contracts/src/types';
import type { AssociatedCarLevel } from '../evCarLinkReadModel';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import { clearCarStateOfCharge } from './carStateOfChargeWrite';
import {
  updateStateOfChargeFromCarObservation,
} from './stateOfCharge';

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
  eligibleCarIds: readonly string[],
  associated: AssociatedCarSnapshot | undefined,
): AssociatedCarSnapshot | undefined => {
  if (eligibleCarIds.length === 0) return undefined;
  if (!associated) return undefined;
  return eligibleCarIds.includes(associated.carId) ? associated : undefined;
};

/**
 * Drops the charger's car-sourced level when its association ends or is
 * suspended. Unconditional on eligibility: if a level got there via a car, the
 * association becoming unusable is what clears it, whatever the user has ticked
 * since.
 */
export const clearAssociatedCarStateOfCharge = (
  snapshotStore: TransportSnapshotStore,
  chargerId: string,
): boolean => {
  const snapshot = snapshotStore.getSnapshotByDeviceId(chargerId);
  return snapshot ? clearCarStateOfCharge({ snapshot }) : false;
};

/**
 * Applies a car-reported battery level to its charger, when the user opted that
 * charger in. Returns whether the stored level actually moved, so the caller
 * only dispatches on a real change.
 *
 * The eligibility check happens HERE rather than in the probe: the probe reports
 * what it observed and stays settings-free, and this is the one place that turns
 * an observation into a write.
 *
 * The CAR's own plug state is the guard on an adopted level — a car that has
 * left has none to lend — and it is applied by the producer, not here:
 * `resolveAssociatedCarSnapshot` refuses to resolve an association for a
 * disconnected car, so there is nothing to write. Re-checking it here would read
 * `chargingState`, which the contract declares display-only precisely so a car
 * app's reporting lag cannot drive a control path.
 */
export const applyAssociatedCarStateOfCharge = (
  eligibleCarIds: readonly string[],
  associatedCar: AssociatedCarSnapshot | undefined,
  snapshotStore: TransportSnapshotStore,
  reading: AssociatedCarLevel,
): boolean => {
  const associated = resolveAssociatedCar(eligibleCarIds, associatedCar);
  if (associated?.carId !== reading.carId) return false;
  const snapshot = snapshotStore.getSnapshotByDeviceId(reading.chargerId);
  if (!snapshot) return false;
  return updateStateOfChargeFromCarObservation({
    snapshot,
    percent: reading.socPct,
    observedAtMs: reading.socAtMs,
    carId: reading.carId,
    chargeLimitPct: reading.chargeLimitPct,
  });
};
