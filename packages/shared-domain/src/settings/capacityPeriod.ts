import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings';

export const DEFAULT_CAPACITY_PERIOD_MINUTES: CapacityPeriodMinutes = 60;
export const CAPACITY_QUARTER_MS = 15 * 60 * 1000;

export const isCapacityPeriodMinutes = (value: unknown): value is CapacityPeriodMinutes => (
  value === 15 || value === 60
);

/** Resolve untrusted persisted/UI input without inventing a third period. */
export const resolveCapacityPeriodMinutes = (
  value: unknown,
  fallback: CapacityPeriodMinutes,
): CapacityPeriodMinutes => (isCapacityPeriodMinutes(value) ? value : fallback);

export const capacityPeriodHours = (periodMinutes: CapacityPeriodMinutes): number => periodMinutes / 60;

/** The energy a steady `kw` delivers over one capacity period. */
export const capacityPeriodEnergyKWh = (kw: number, periodMinutes: CapacityPeriodMinutes): number => (
  kw * capacityPeriodHours(periodMinutes)
);
