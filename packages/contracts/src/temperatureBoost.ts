import type {
  TargetCapabilitySnapshot,
  TemperatureBoostSettings,
} from './types.js';

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const hasTemperatureBoostTarget = (
  targets: readonly TargetCapabilitySnapshot[] | undefined,
): boolean => (
  targets?.some((target) => target.id === 'target_temperature') === true
);

export const normalizeTemperatureBoostSettings = (value: unknown): TemperatureBoostSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([deviceId, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const config = entry as Record<string, unknown>;
      if (config.enabled !== true) return [];
      if (!isFiniteNumber(config.boostBelowC)) return [];
      return [[deviceId, {
        enabled: true,
        boostBelowC: config.boostBelowC,
      }]];
    }),
  );
};
