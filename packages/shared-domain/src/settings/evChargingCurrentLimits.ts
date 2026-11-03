import type { EvChargingCurrentLimitsMap, EvChargingCurrentLimits } from '../../../contracts/src/types';
import { isUnknownRecord } from '../recordGuards';

/** A car's active charging range; pausing remains available below its minimum. */
export const readEvChargingCurrentLimits = (value: unknown): EvChargingCurrentLimits | undefined => {
  if (!isUnknownRecord(value)) return undefined;
  const { minA, maxA } = value;
  if (typeof minA !== 'number' || typeof maxA !== 'number'
    || !Number.isInteger(minA) || !Number.isInteger(maxA)
    || minA < 6 || maxA > 32 || minA > maxA) return undefined;
  return { minA, maxA };
};

/** Shared boundary for car overrides and charger defaults. The setting key owns the identity. */
export const normalizeEvChargingCurrentLimitsMap = (value: unknown): EvChargingCurrentLimitsMap => {
  if (!isUnknownRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([carId, raw]) => {
    const limits = readEvChargingCurrentLimits(raw);
    return carId.length > 0 && limits ? [[carId, limits]] : [];
  }));
};

/** A failed policy read must not turn a saved charging range into unrestricted charging. */
export const isEvChargingCurrentLimitsMap = (value: unknown): value is EvChargingCurrentLimitsMap => (
  isUnknownRecord(value) && Object.entries(value).every(([carId, limits]) => (
    carId.length > 0 && readEvChargingCurrentLimits(limits) !== undefined
  ))
);
