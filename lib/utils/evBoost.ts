import type { EvBoostSettings } from '../../packages/contracts/src/types';

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const normalizeEvBoostSettings = (value: unknown): EvBoostSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([deviceId, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const config = entry as Record<string, unknown>;
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
