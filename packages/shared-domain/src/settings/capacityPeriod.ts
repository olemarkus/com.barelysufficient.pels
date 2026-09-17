/** The billing window whose average import power the hard cap protects. */
export type CapacityPeriodMinutes = 15 | 60;

/** The resolved capacity-control settings shared by runtime and settings UI. */
export type CapacitySettings = {
  limitKw: number;
  marginKw: number;
  periodMinutes: CapacityPeriodMinutes;
};

export const DEFAULT_CAPACITY_PERIOD_MINUTES: CapacityPeriodMinutes = 60;
export const CAPACITY_QUARTER_MS = 15 * 60 * 1000;

/** Resolve untrusted persisted/UI input without inventing a third period. */
export const resolveCapacityPeriodMinutes = (
  value: unknown,
  fallback: CapacityPeriodMinutes = DEFAULT_CAPACITY_PERIOD_MINUTES,
): CapacityPeriodMinutes => value === 15 || value === 60 ? value : fallback;

export const capacityPeriodHours = (periodMinutes: CapacityPeriodMinutes): number => periodMinutes / 60;
