import { getZonedParts } from '../../packages/shared-domain/src/utils/dateUtils';
import type { EffectiveProfileData } from './dailyBudgetProfile';
import type { DayContext } from './dailyBudgetState';

type PlanWeights = {
  combined: number[];
  uncontrolled: number[];
  controlled: number[];
};

export function buildPlanWeights(context: DayContext, profile: EffectiveProfileData): PlanWeights {
  const { uncontrolled, controlled } = profile.breakdown;
  const hasSplitProfiles = controlled.length > 0 && uncontrolled.length > 0;
  const uncontrolledWeights = buildHourWeights(context, hasSplitProfiles ? uncontrolled : profile.combinedWeights);
  if (!hasSplitProfiles) {
    return {
      combined: uncontrolledWeights,
      uncontrolled: uncontrolledWeights.slice(),
      controlled: uncontrolledWeights.map(() => 0),
    };
  }
  const controlledWeights = buildHourWeights(context, controlled);
  return {
    combined: uncontrolledWeights.map((value, index) => value + (controlledWeights[index] ?? 0)),
    uncontrolled: uncontrolledWeights,
    controlled: controlledWeights,
  };
}

export function resolveSplitShares(weights: PlanWeights): { uncontrolled: number[]; controlled: number[] } {
  const entries = weights.uncontrolled.map((uncontrolledWeight, index) => {
    const controlledWeight = weights.controlled[index] ?? 0;
    const safeUncontrolled = Math.max(0, uncontrolledWeight);
    const safeControlled = Math.max(0, controlledWeight);
    const total = safeUncontrolled + safeControlled;
    if (total <= 0) {
      return { uncontrolled: 1, controlled: 0 };
    }
    return {
      uncontrolled: safeUncontrolled / total,
      controlled: safeControlled / total,
    };
  });
  return {
    uncontrolled: entries.map((entry) => entry.uncontrolled),
    controlled: entries.map((entry) => entry.controlled),
  };
}

function buildHourWeights(context: DayContext, profileWeights: number[]): number[] {
  return context.bucketStartUtcMs.map((ts) => {
    const hour = getZonedParts(new Date(ts), context.timeZone).hour;
    return profileWeights[hour] ?? 0;
  });
}
