import type { PowerLimitCeiling, PowerLimitSettings } from '../../../contracts/src/capacitySettings';
import { usableCapacityKw } from '../capacityAllowance';
import { isFiniteNumber } from '../numberGuards';

/**
 * One power-limit control as read back: its value, or `malformed` when what
 * was read is not a value the control can hold. Malformed is a fact about the
 * read, never a default: the reader decides what an unusable read means (the
 * runtime store carries the last accepted posture for that control alone, the
 * settings UI treats the whole block as unavailable).
 */
export type PowerLimitControlRead<T> = { state: 'resolved'; value: T } | { state: 'malformed' };

const MALFORMED: { state: 'malformed' } = { state: 'malformed' };

/** The Capacity limit switch. */
export function resolveCapacityEnabledSetting(capacityEnabled: unknown): PowerLimitControlRead<boolean> {
  return typeof capacityEnabled === 'boolean' ? { state: 'resolved', value: capacityEnabled } : MALFORMED;
}

/**
 * The grid import pair: the switch and its threshold, resolved together
 * because an enabled switch is only usable with a valid threshold. A disabled
 * switch keeps whatever threshold is stored without enforcing it.
 */
export function resolveGridImportLimitSetting(
  gridEnabled: unknown,
  gridLimitKw: unknown,
): PowerLimitControlRead<number | null> {
  if (gridEnabled === false) return { state: 'resolved', value: null };
  if (gridEnabled !== true || !isValidGridImportLimitKw(gridLimitKw)) return MALFORMED;
  return { state: 'resolved', value: gridLimitKw };
}

/** Defaults apply only to keys that have never been written. A missed read is unavailable. */
export function resolvePowerLimitSettings(
  capacityEnabled: unknown,
  gridEnabled: unknown,
  gridLimitKw: unknown,
): Pick<PowerLimitSettings, 'capacityEnabled' | 'gridImportLimitKw'> | null {
  const capacity = resolveCapacityEnabledSetting(capacityEnabled);
  const grid = resolveGridImportLimitSetting(gridEnabled, gridLimitKw);
  if (capacity.state === 'malformed' || grid.state === 'malformed') return null;
  return { capacityEnabled: capacity.value, gridImportLimitKw: grid.value };
}

export const isValidGridImportLimitKw = (value: unknown): value is number => (
  isFiniteNumber(value) && value > 0
);

/** Automatic live-control margin; independent of the capacity-period safety margin. */
export const gridImportTargetKw = (limitKw: number): number => limitKw * 0.95;

// The lower of two enabled limits; grid wins an exact tie, as it does for the live
// binding source (`resolveSoftLimitSource`, `lib/plan/planContext.ts`).
const lowerLimit = (capacityKw: number | null, gridKw: number | null): PowerLimitCeiling | null => {
  if (gridKw === null) return capacityKw === null ? null : { limit: 'capacity', kw: capacityKw };
  return capacityKw !== null && capacityKw < gridKw
    ? { limit: 'capacity', kw: capacityKw }
    : { limit: 'grid', kw: gridKw };
};

/**
 * The planning ceiling: the import rate planning forecasts against. It is the
 * hard cap minus its safety margin while Capacity limit is on, the grid import
 * target while Grid import limit is on, and the lower of the two when both are.
 * `null` when neither is enabled: nothing caps the house, so nothing is planned
 * against. A home with only Capacity limit on (every install before the grid
 * limit existed) gets exactly `usableCapacityKw(limitKw, marginKw)`.
 *
 * A forecast that spends an instantaneous grid limit as an hourly rate is an
 * approximation; live admission still enforces the measured grid headroom.
 *
 * The runtime owner is `resolvePlanningPowerCeiling` (`lib/power/capacityModel.ts`).
 * The arithmetic lives here, beside `gridImportTargetKw`, for the reason
 * `usableCapacityKw` does: consumers the owner cannot serve apply it too. The
 * Budget page recommends a daily budget from the Limits form's values
 * (`packages/settings-ui/src/ui/budgetRedesign.ts`), and the weather domain,
 * which may not import `lib/power`, suggests budgets under the same ceiling.
 */
export function planningPowerCeiling(settings: PowerLimitSettings): PowerLimitCeiling | null {
  return lowerLimit(
    settings.capacityEnabled ? usableCapacityKw(settings.limitKw, settings.marginKw) : null,
    settings.gridImportLimitKw === null ? null : gridImportTargetKw(settings.gridImportLimitKw),
  );
}

/**
 * The configured ceiling: the lower enabled limit as the owner configured it,
 * the hard cap or the grid import limit, before the safety margin or the grid
 * target. `null` when neither is enabled. With only Capacity limit on it is
 * exactly `limitKw`, so readings that measured against the hard cap itself keep
 * doing so. Its consumer is the price domain (`resolveExpectedManagedDrawKwh`),
 * which may not import `lib/power`.
 */
export function configuredPowerCeiling(settings: PowerLimitSettings): PowerLimitCeiling | null {
  return lowerLimit(settings.capacityEnabled ? settings.limitKw : null, settings.gridImportLimitKw);
}
