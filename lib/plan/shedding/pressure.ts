import { isOverShortfallThreshold } from '../../power/capacityGuard';
import type { MeasuredPower } from '../planContext';
import type { StorageShedTerm } from './types';

/** Ordinary pacing may give a demand restriction a bounded opportunity to respond. */
export type ShedPressure =
  | { kind: 'soft' | 'capacity' | 'directive' }
  | { kind: 'hard_cap' | 'grid'; deficitKw: number };

export function resolveShedPressure(
  power: MeasuredPower, shortfallThresholdKw: number | null, storage: StorageShedTerm,
): ShedPressure {
  const hardCapDeficitKw = shortfallThresholdKw !== null && isOverShortfallThreshold(power.drawKw, shortfallThresholdKw)
    ? power.drawKw - shortfallThresholdKw : 0;
  const gridDeficitKw = power.gridHeadroomKw === null ? 0 : Math.max(0, -power.gridHeadroomKw);
  // Urgency is classified against the actual cap, but cuts must preserve the
  // capacity pace's response margin. The actual projection can also be more
  // conservative at the period boundary, so keep the strongest physical need.
  const capacityDeficitKw = power.capacityHeadroomKw === null ? 0 : Math.max(0, -power.capacityHeadroomKw);
  const deficitKw = Math.max(0, capacityDeficitKw, hardCapDeficitKw, gridDeficitKw) - storage.netCreditKw;
  if (gridDeficitKw > 0) return { kind: 'grid', deficitKw: Math.max(0, deficitKw) };
  if (hardCapDeficitKw > 0) return { kind: 'hard_cap', deficitKw: Math.max(0, deficitKw) };
  return { kind: power.capacityBreached ? 'capacity' : 'soft' };
}

export const permitsDemandRelief = (pressure: ShedPressure): boolean => (
  pressure.kind === 'soft' || pressure.kind === 'capacity'
);

/** Urgent action answers the physical breach; residual pacing is reconsidered on the next reading. */
export function resolveShedNeedKw(pressure: ShedPressure, bindingDeficitKw: number): number {
  return 'deficitKw' in pressure ? Math.min(bindingDeficitKw, pressure.deficitKw) : bindingDeficitKw;
}
