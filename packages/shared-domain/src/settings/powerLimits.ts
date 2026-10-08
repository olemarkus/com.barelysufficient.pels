import type { PowerLimitSettings } from '../../../contracts/src/capacitySettings';
import { isFiniteNumber } from '../numberGuards';

/** Defaults apply only to keys that have never been written. A missed read is unavailable. */
export function resolvePowerLimitSettings(
  capacityEnabled: unknown,
  gridEnabled: unknown,
  gridLimitKw: unknown,
): Pick<PowerLimitSettings, 'capacityEnabled' | 'gridImportLimitKw'> | null {
  if (typeof capacityEnabled !== 'boolean' || typeof gridEnabled !== 'boolean') return null;
  if (!gridEnabled) return { capacityEnabled, gridImportLimitKw: null };
  if (!isValidGridImportLimitKw(gridLimitKw)) return null;
  return { capacityEnabled, gridImportLimitKw: gridLimitKw };
}

export const isValidGridImportLimitKw = (value: unknown): value is number => (
  isFiniteNumber(value) && value > 0
);

/** Automatic live-control margin; independent of the capacity-period safety margin. */
export const gridImportTargetKw = (limitKw: number): number => limitKw * 0.95;

