import type { PowerLimitControlRead } from './powerLimits';

/**
 * The `capacity_follow_month_peak` setting (home-scopable): whether the hard cap
 * PELS holds in live control rises to this month's highest completed quarter
 * once that quarter is above the configured hard cap. It applies only with
 * Capacity limit on and the 15-minute period (`lib/power/heldCapacityLimit.ts`).
 *
 * The settings UI writes it (Limits & safety, beside the month's peak); the
 * runtime reads it with the capacity block (`lib/power/capacitySettingsStore.ts`).
 * New installs in Belgium have it written on once (`lib/power/capacityMarketDefault.ts`).
 *
 * Absence stays with the caller: the runtime reads a never-written key as off,
 * and carries its last accepted value through a listed key that does not read
 * back as a boolean.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/** Read policy: a boolean is the owner's choice; anything else is a malformed read. */
export const resolveCapacityFollowMonthPeakSetting = (raw: unknown): PowerLimitControlRead<boolean> => (
  typeof raw === 'boolean' ? { state: 'resolved', value: raw } : { state: 'malformed' }
);

/** Write policy: only a boolean is ever persisted. */
export function assertCapacityFollowMonthPeakWrite(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error('The month-peak switch takes on or off.');
}
