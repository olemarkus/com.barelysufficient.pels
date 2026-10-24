import type { EvBoostSettings } from '../../../contracts/src/types';
import { isFiniteNumber } from '../numberGuards';
import { isUnknownRecord } from '../recordGuards';

export const normalizeEvBoostSettings = (value: unknown): EvBoostSettings => {
  if (!isUnknownRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([deviceId, entry]) => {
      if (!isUnknownRecord(entry)) return [];
      const config = entry;
      if (config.enabled !== true) return [];
      if (!isFiniteNumber(config.boostBelowPercent)) return [];
      if (config.boostBelowPercent < 0 || config.boostBelowPercent > 100) return [];
      return [[deviceId, {
        enabled: true,
        boostBelowPercent: config.boostBelowPercent,
      }]];
    }),
  );
};
