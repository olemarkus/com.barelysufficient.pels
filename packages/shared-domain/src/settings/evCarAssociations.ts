import type { EvCarAssociationConfig, EvCarAssociations } from '../../../contracts/src/types';
import { isUnknownRecord } from '../recordGuards';

/**
 * A charger's entry. A standing car stands only for the charger's sole
 * selected car: with a second car selected it would claim a connection
 * another car may own.
 */
export const buildEvCarAssociationConfig = (
  carIds: string[], assumedCarId: unknown,
): EvCarAssociationConfig => (
  typeof assumedCarId === 'string' && carIds.length === 1 && assumedCarId === carIds[0]
    ? { carIds, assumedCarId } : { carIds }
);

/**
 * The parse boundary for the persisted `ev_car_associations` setting, read by the
 * runtime and by the settings UI's car picker alike.
 */
export const normalizeEvCarAssociations = (value: unknown): EvCarAssociations => {
  if (!isUnknownRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([chargerId, entry]) => {
      if (!isUnknownRecord(entry)) return [];
      const rawCarIds = entry.carIds;
      if (!Array.isArray(rawCarIds)) return [];
      const carIds = [...new Set(
        rawCarIds.filter((carId): carId is string => typeof carId === 'string' && carId.length > 0),
      )];
      // An empty eligibility set is indistinguishable from "off", so it is not
      // stored — otherwise a charger the user un-ticked every car on would keep
      // an entry that reads as configured everywhere downstream.
      if (carIds.length === 0) return [];
      return [[chargerId, buildEvCarAssociationConfig(carIds, entry.assumedCarId)]];
    }),
  );
};
