import type { AssociatedCarSnapshot } from '../../../packages/contracts/src/types';
import type { DeviceTransportParseProviders } from './managerParseDevice';
import type { TransportEvCarLinkProducer } from './transportContext';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { clearCarStateOfCharge } from './carStateOfChargeWrite';
import {
  EV_SOC_CAPABILITY_ID,
  updateStateOfChargeFromCarObservation,
} from './stateOfCharge';

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

/**
 * Applies a car-reported battery level to its charger, when the user opted that
 * charger in. Returns whether the stored level actually moved, so the caller
 * only dispatches on a real change.
 *
 * The eligibility check happens HERE rather than in the probe: the probe reports
 * what it observed and stays settings-free, and this is the one place that turns
 * an observation into a write.
 */
export const applyAssociatedCarStateOfCharge = (
  ctx: CarAssociationSources & {
    latestSnapshotById: ReadonlyMap<string, TransportDeviceSnapshot>;
  },
  reading: { chargerId: string; carId: string; socPct: number; socAtMs: number },
  nowMs: number,
): boolean => {
  const associated = resolveAssociatedCar(ctx, reading.chargerId);
  if (associated?.carId !== reading.carId) return false;
  const snapshot = ctx.latestSnapshotById.get(reading.chargerId);
  if (!snapshot) return false;
  return updateStateOfChargeFromCarObservation({
    snapshot,
    percent: reading.socPct,
    observedAtMs: reading.socAtMs,
    carId: reading.carId,
    nowMs,
  });
};

/**
 * Drops the charger's car-sourced level when its session ends. Unconditional on
 * eligibility: if a level got there via a car, the car leaving is what ends it,
 * whatever the user has ticked since.
 */
export const clearAssociatedCarStateOfCharge = (
  ctx: { latestSnapshotById: ReadonlyMap<string, TransportDeviceSnapshot> },
  chargerId: string,
): boolean => {
  const snapshot = ctx.latestSnapshotById.get(chargerId);
  return snapshot ? clearCarStateOfCharge({ snapshot }) : false;
};

/**
 * The two probe callbacks, bound to a transport. Built here rather than inline
 * in `DeviceTransport` so the adoption decision and the write live together, and
 * the hub keeps one import instead of three.
 */
export const createCarStateOfChargeAdoption = (params: {
  getCtx: () => CarAssociationSources & {
    latestSnapshotById: ReadonlyMap<string, TransportDeviceSnapshot>;
  };
  /**
   * Dispatched as a `measure_battery` observation, so the existing EV-boost
   * plan-rebuild gate fires exactly as it does for a charger's own report.
   */
  dispatch: (chargerId: string, capabilityId: string) => void;
  /** Injectable only so a test can pin it; the transport reads the wall clock. */
  now?: () => number;
}) => ({
  onAssociatedCarStateOfCharge: (reading: {
    chargerId: string; carId: string; socPct: number; socAtMs: number;
  }): void => {
    if (!applyAssociatedCarStateOfCharge(params.getCtx(), reading, (params.now ?? Date.now)())) return;
    params.dispatch(reading.chargerId, EV_SOC_CAPABILITY_ID);
  },
  onAssociationEnded: (chargerId: string): void => {
    if (!clearAssociatedCarStateOfCharge(params.getCtx(), chargerId)) return;
    params.dispatch(chargerId, EV_SOC_CAPABILITY_ID);
  },
});
