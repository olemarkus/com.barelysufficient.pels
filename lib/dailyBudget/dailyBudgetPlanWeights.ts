import { getZonedParts } from '../utils/dateUtils';
import { buildCompositeWeights } from './dailyBudgetAllocation';

type PlanWeights = {
  combined: number[];
  uncontrolled: number[];
  controlled: number[];
};

export function buildPlanWeights(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  profileWeights: number[];
  profileWeightsControlled?: number[];
  profileWeightsUncontrolled?: number[];
  priceFactors?: Array<number | null>;
  flexShare: number;
}): PlanWeights {
  const {
    bucketStartUtcMs,
    timeZone,
    profileWeights,
    profileWeightsControlled,
    profileWeightsUncontrolled,
    priceFactors,
    flexShare,
  } = params;
  const hasSplitProfiles = Array.isArray(profileWeightsControlled)
    && Array.isArray(profileWeightsUncontrolled)
    && profileWeightsControlled.length > 0
    && profileWeightsUncontrolled.length > 0;
  const uncontrolledWeights = buildHourWeights({
    bucketStartUtcMs,
    profileWeights: hasSplitProfiles ? profileWeightsUncontrolled : profileWeights,
    timeZone,
  });
  if (!hasSplitProfiles) {
    const combined = buildCompositeWeights({ baseWeights: uncontrolledWeights, priceFactors, flexShare });
    return {
      combined,
      uncontrolled: combined.slice(),
      controlled: combined.map(() => 0),
    };
  }
  const controlledWeights = buildHourWeights({
    bucketStartUtcMs,
    profileWeights: profileWeightsControlled,
    timeZone,
  });
  const controlledShapedWeights = buildCompositeWeights({
    baseWeights: controlledWeights,
    priceFactors,
    flexShare,
  });
  const combined = uncontrolledWeights.map((value, index) => value + (controlledShapedWeights[index] ?? 0));
  return {
    combined,
    uncontrolled: uncontrolledWeights,
    controlled: controlledShapedWeights,
  };
}

export function resolveSplitShares(params: {
  uncontrolledWeights: number[];
  controlledWeights: number[];
}): { uncontrolled: number[]; controlled: number[] } {
  const { uncontrolledWeights, controlledWeights } = params;
  const entries = uncontrolledWeights.map((uncontrolledWeight, index) => {
    const controlledWeight = controlledWeights[index] ?? 0;
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

function buildHourWeights(params: {
  bucketStartUtcMs: number[];
  profileWeights: number[];
  timeZone: string;
}): number[] {
  const { bucketStartUtcMs, profileWeights, timeZone } = params;
  return bucketStartUtcMs.map((ts) => {
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    return profileWeights[hour] ?? 0;
  });
}
