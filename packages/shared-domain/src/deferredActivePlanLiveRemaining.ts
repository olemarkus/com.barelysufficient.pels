import type { ResolvedDeferredObjectiveActivePlanV1 } from '../../contracts/src/deferredObjectiveActivePlans';
import { resolveRemainingEnergyKWh } from './energyQuantities';
import { isFiniteNumber } from './numberGuards';

/**
 * Energy a smart task still needs right now, in the revision's own two
 * figures: `neededKWh` is the buffered amount the planner books, `expectedKWh`
 * the mean-based estimate. Zero for both means the target is reached.
 */
export type LiveRemainingEnergy = {
  neededKWh: number;
  expectedKWh: number;
};

/**
 * The latest revision's energy figures, brought forward to the task's live
 * reading.
 *
 * A revision records the energy still needed at its own moment, and a revision
 * lands about once an hour, so between revisions those figures go stale by up
 * to an hour of delivery. This rescales them from live progress, keeping the
 * revision's rate and buffer:
 *
 * - an energy task needs `targetValue - deliveredKWh`, exactly (one kWh per kWh,
 *   no buffer);
 * - a temperature or SoC task needs the units left now times the rate the plan
 *   was built with (`latest.rateMean`), and the buffered figure keeps the
 *   revision's own needed-to-expected ratio.
 *
 * A temperature or SoC figure moves only when the reading does, in its steps
 * (0.5 °C, 1 % of charge), while delivered energy rises continuously. Adding
 * the two does not give a steady run total: it climbs until the next step and
 * then falls back. The run's total is the latest revision's, the energy
 * delivered by then plus its `energyNeededKWh` (`deadlinePlanHero.ts`).
 *
 * Null when there is no live answer: no revision, no live reading, an unknown
 * direction of travel, or no recorded rate. The caller then reads the
 * revision's figures as they are.
 */
export const resolveLiveRemainingEnergy = (
  plan: ResolvedDeferredObjectiveActivePlanV1,
  currentValue: number | null,
): LiveRemainingEnergy | null => {
  const latest = plan.latest;
  if (!latest) return null;
  if (plan.objectiveKind === 'energy') {
    const remaining = Math.max(0, plan.targetValue - plan.deliveredKWh);
    return { neededKWh: remaining, expectedKWh: remaining };
  }
  if (currentValue === null || plan.progressDirection === 'unknown') return null;
  const rate = latest.rateMean;
  if (!isFiniteNumber(rate) || rate <= 0) return null;
  const unitsLeft = plan.progressDirection === 'increasing'
    ? plan.targetValue - currentValue
    : currentValue - plan.targetValue;
  if (unitsLeft <= 0) return { neededKWh: 0, expectedKWh: 0 };
  const revisionExpected = resolveRemainingEnergyKWh(latest);
  const bufferRatio = revisionExpected !== null && latest.energyNeededKWh > 0
    ? latest.energyNeededKWh / revisionExpected
    : 1;
  const expectedKWh = unitsLeft * rate;
  return { neededKWh: expectedKWh * bufferRatio, expectedKWh };
};
