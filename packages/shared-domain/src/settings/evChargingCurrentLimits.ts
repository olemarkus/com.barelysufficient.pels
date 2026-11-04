import type {
  EvChargingCurrentLimitsMap, EvChargingCurrentLimits, SteppedLoadProfile, TargetPowerSteppedLoadPreset,
} from '../../../contracts/src/types';
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

/**
 * A charging range bounds amps, so it applies only where the active ladder
 * says which current each level draws: an EV phase model, or levels that carry
 * their current. A ladder of charger-published watts is already the charger's
 * own configured range and is used as published.
 */
export const chargingLadderCarriesCurrent = (
  profile: SteppedLoadProfile | undefined, preset: TargetPowerSteppedLoadPreset | undefined,
): boolean => {
  if (preset === 'ev_charger_1_phase' || preset === 'ev_charger_3_phase') return true;
  const levels = profile?.steps.filter((step) => step.planningPowerW > 0) ?? [];
  return levels.length > 0 && levels.every((step) => step.planningCurrentA !== undefined);
};
