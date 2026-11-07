/** Diagnostic delivery speed consumes the allocator's canonical objective rungs. */
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveObjectiveSteps } from './objectiveSteps';

/**
 * First strictly-positive finite value from `values`, or `null` when none.
 * Shared with the diagnostics bridge and EV calibration helpers so device
 * "expected/planned/measured" candidate lists stay in agreement on what
 * counts as a usable nameplate.
 */
export const firstPositiveFinite = (values: readonly unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
};

/** Diagnostic speed is the slowest useful rung the allocator can actually use. */
export const resolvePlanningSpeedKw = (device: ObjectiveDeviceInput | undefined): number | null => {
  if (!device) return null;
  const usefulPowers = resolveObjectiveSteps(device)
    .map((step) => step.usefulPowerKw)
    .filter((powerKw) => Number.isFinite(powerKw) && powerKw > 0);
  return usefulPowers.length === 0 ? null : Math.min(...usefulPowers);
};
