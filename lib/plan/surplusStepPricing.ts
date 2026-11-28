import type { ChargingDrawPhases } from '../../packages/planner-types/src/phaseFootprint';
import type { SteppedLoadProfile, SteppedLoadStep } from '../../packages/contracts/src/types';
import { isSteppedLoadOffStep, sortSteppedLoadSteps } from '../../packages/shared-domain/src/deviceControlProfiles';
import { resolveOperatingChargingPhases, resolveStepChargingPhases } from '../phaseFootprint/chargingPhaseFootprints';
import type { MeteredPlanInputDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';

/**
 * Solar surplus pricing of a charger's rungs.
 *
 * A charger ladder names its rungs at the installation's geometry: 6 A on a
 * three-phase charger is about 4.1 kW. A one-phase car on that charger takes a
 * third of it. Pricing the solar claim at the ladder's figure would hold the
 * car at its lowest rung while the rest of the surplus is exported. So the
 * surplus allocator, and only it, prices a rung at the phases the car draws on
 * (`PlanInputDevice.chargingDrawPhases`, resolved and kept for the plug-in
 * session by its owners).
 *
 * Phase room stays in the ladder's geometry, the one `phaseFootprint`, restore
 * and fuse protection use: a rung's nameplate spread over the footprint is what
 * each of the car's phases really carries. The allocator converts between the
 * two with {@link surplusDrawShare}.
 */

/** What a rung takes from the surplus, kW: its nameplate, scaled down to the phases the car draws on. */
export function surplusStepKw(step: SteppedLoadStep, drawPhases: ChargingDrawPhases): number {
  const nameplateKw = step.planningPowerW / 1000;
  const phases = resolveStepChargingPhases(step);
  if (drawPhases.kind === 'ladder' || phases === undefined || drawPhases.phases >= phases) return nameplateKw;
  return nameplateKw * (drawPhases.phases / phases);
}

/** The highest active rung whose surplus price fits `budgetKw`, or null when even the floor does not. */
export function resolveHighestSurplusStepWithinKw(
  profile: SteppedLoadProfile,
  budgetKw: number,
  drawPhases: ChargingDrawPhases,
): SteppedLoadStep | null {
  if (!Number.isFinite(budgetKw)) return null;
  let best: SteppedLoadStep | null = null;
  for (const step of sortSteppedLoadSteps(profile.steps)) {
    if (isSteppedLoadOffStep(profile, step.id) || step.planningPowerW <= 0) continue;
    if (surplusStepKw(step, drawPhases) > budgetKw) continue;
    if (best === null || step.planningPowerW > best.planningPowerW) best = step;
  }
  return best;
}

/**
 * The share of a tracking charger's ladder figure the car really draws: 1/3 for
 * a one-phase car on a three-phase ladder, otherwise 1. Surplus kW divided by it
 * is ladder kW, the unit of phase room.
 */
export function surplusDrawShare(dev: MeteredPlanInputDevice): number {
  const draw = dev.chargingDrawPhases;
  if (draw.kind === 'ladder' || !dev.surplusTracking || !isSteppedLoadDevice(dev)) return 1;
  const ladder = resolveOperatingChargingPhases(dev.steppedLoadProfile);
  return ladder === undefined || draw.phases >= ladder ? 1 : draw.phases / ladder;
}
