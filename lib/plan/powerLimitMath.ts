import { gridImportTargetKw } from '../../packages/shared-domain/src/settings/powerLimits';
import type { PlanContext } from './planContext';
import { SHEDDING_CLEAR_THRESHOLD_KW } from './planConstants';

/** null is genuine absence of a constraint, never an unbounded numeric sentinel. */
export function minPowerLimit(...limits: readonly (number | null)[]): number | null {
  const enabled = limits.filter((limit): limit is number => limit !== null);
  return enabled.length === 0 ? null : Math.min(...enabled);
}

/** The grid import target of a resolved limit: `null` when the grid limit is off. */
export const resolveGridImportTargetKw = (limitKw: number | null): number | null => (
  limitKw === null ? null : gridImportTargetKw(limitKw)
);

export const spendPowerHeadroom = (availableKw: number | null, neededKw: number): number | null => (
  availableKw === null ? null : availableKw - neededKw
);

/** The shared recovery band remains attainable even on a small grid connection. */
export const resolveSheddingClearThresholdKw = (context: PlanContext): number => (
  context.gridImportTargetKw === null
    ? SHEDDING_CLEAR_THRESHOLD_KW
    : Math.min(SHEDDING_CLEAR_THRESHOLD_KW, context.gridImportTargetKw * 0.1)
);
