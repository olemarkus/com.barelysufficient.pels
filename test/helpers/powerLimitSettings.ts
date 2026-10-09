import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { DeferredObjectivePowerLimit } from '../../lib/objectives/deferredObjectives/types';

/**
 * Capacity limit on, grid import limit off, hourly period: every install before
 * the grid import limit existed. Its planning ceiling is `limitKw - marginKw`.
 */
export const capacityOnlyPowerLimits = (limitKw: number, marginKw = 0): PowerLimitSettings => ({
  capacityEnabled: true,
  gridImportLimitKw: null,
  limitKw,
  marginKw,
  periodMinutes: 60,
});

/**
 * The same capacity scalars with the switches set explicitly, for specs that
 * cover Capacity limit off and the grid import limit. The scalars stay
 * persisted while Capacity limit is off, so they are still supplied.
 */
export const powerLimits = (
  capacity: { enabled: boolean; limitKw: number; marginKw: number },
  gridImportLimitKw: number | null,
): PowerLimitSettings => ({
  capacityEnabled: capacity.enabled,
  gridImportLimitKw,
  limitKw: capacity.limitKw,
  marginKw: capacity.marginKw,
  periodMinutes: 60,
});

/**
 * A smart-task horizon under Capacity limit alone: limited, with no instantaneous
 * admission ceiling. The horizon every planner spec ran under before the grid
 * import limit existed.
 */
export const CAPACITY_ONLY_HORIZON_LIMIT: DeferredObjectivePowerLimit = { kind: 'limited', admissionCeilingKw: null };
