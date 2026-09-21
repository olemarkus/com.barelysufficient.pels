import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import { usableCapacityKw } from '../../packages/shared-domain/src/capacityAllowance';

/** Sustainable daily-budget ceiling rate: hard cap minus safety margin. */
export const resolveWeatherSustainableCapacityKw = (settings: CapacitySettings): number => (
  usableCapacityKw(settings.limitKw, settings.marginKw)
);
