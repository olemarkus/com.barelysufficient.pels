import type { TargetCapabilitySnapshot, TemperatureBoostSettings } from '../../../contracts/src/types';
import { isFiniteNumber } from '../numberGuards';
import { isUnknownRecord } from '../recordGuards';

export const hasTemperatureBoostTarget = (
  targets: readonly TargetCapabilitySnapshot[] | undefined,
): boolean => (
  targets?.some((target) => target.id === 'target_temperature') === true
);

export const normalizeTemperatureBoostSettings = (value: unknown): TemperatureBoostSettings => {
  if (!isUnknownRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([deviceId, entry]) => {
      if (!isUnknownRecord(entry)) return [];
      const config = entry;
      if (config.enabled !== true) return [];
      if (!isFiniteNumber(config.boostBelowC)) return [];
      return [[deviceId, {
        enabled: true,
        boostBelowC: config.boostBelowC,
      }]];
    }),
  );
};
