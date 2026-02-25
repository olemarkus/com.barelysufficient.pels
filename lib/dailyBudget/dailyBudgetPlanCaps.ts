import { getZonedParts } from '../utils/dateUtils';
import { clamp } from '../utils/mathUtils';
import { OBSERVED_HOURLY_PEAK_MARGIN_RATIO } from './dailyBudgetConstants';

const PLAN_CAP_EPSILON = 1e-6;

export function resolveRemainingCaps(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  splitSharesUncontrolled: number[];
  splitSharesControlled: number[];
  controlledUsageWeight: number;
  profileObservedMaxUncontrolledKWh?: number[];
  profileObservedMaxControlledKWh?: number[];
  observedPeakMarginRatio?: number;
  capacityBudgetKWh?: number;
  usedInCurrent: number;
  remainingStartIndex: number;
  currentBucketIndex: number;
}): number[] {
  const {
    bucketStartUtcMs,
    timeZone,
    splitSharesUncontrolled,
    splitSharesControlled,
    controlledUsageWeight,
    profileObservedMaxUncontrolledKWh,
    profileObservedMaxControlledKWh,
    observedPeakMarginRatio,
    capacityBudgetKWh,
    usedInCurrent,
    remainingStartIndex,
    currentBucketIndex,
  } = params;
  const marginRatio = Number.isFinite(observedPeakMarginRatio)
    ? Math.max(0, observedPeakMarginRatio ?? 0)
    : OBSERVED_HOURLY_PEAK_MARGIN_RATIO;
  const weight = clamp(controlledUsageWeight, 0, 1);
  const capacityCap = Number.isFinite(capacityBudgetKWh)
    ? Math.max(0, capacityBudgetKWh ?? 0)
    : Number.POSITIVE_INFINITY;

  return bucketStartUtcMs
    .slice(remainingStartIndex)
    .map((bucketStartMs, index) => {
      const bucketIndex = remainingStartIndex + index;
      const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
      const uncontrolledCap = resolveObservedCap(profileObservedMaxUncontrolledKWh?.[hour], marginRatio);
      const controlledCap = resolveObservedCap(profileObservedMaxControlledKWh?.[hour], marginRatio);
      const blendedCap = blendObservedCaps({
        uncontrolledCap,
        controlledCap,
        controlledUsageWeight: weight,
      });
      const shareUncontrolled = splitSharesUncontrolled[bucketIndex] ?? 1;
      const shareControlled = splitSharesControlled[bucketIndex] ?? 0;
      const blendedShare = blendSplitShare({
        shareUncontrolled,
        shareControlled,
        controlledUsageWeight: weight,
        includeUncontrolled: Number.isFinite(uncontrolledCap),
        includeControlled: Number.isFinite(controlledCap),
      });
      const totalCapFromBlend = Number.isFinite(blendedCap) && blendedShare > PLAN_CAP_EPSILON
        ? blendedCap / blendedShare
        : Number.POSITIVE_INFINITY;
      const effectiveTotalCap = Math.min(capacityCap, totalCapFromBlend);
      if (bucketIndex === currentBucketIndex) {
        return Math.max(0, effectiveTotalCap - usedInCurrent);
      }
      return Math.max(0, effectiveTotalCap);
    });
}

export function resolveRemainingFloors(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  splitSharesUncontrolled: number[];
  splitSharesControlled: number[];
  controlledUsageWeight: number;
  profileObservedMinUncontrolledKWh?: number[];
  profileObservedMinControlledKWh?: number[];
  observedPeakMarginRatio?: number;
  usedInCurrent: number;
  remainingStartIndex: number;
  currentBucketIndex: number;
}): number[] {
  const {
    bucketStartUtcMs,
    timeZone,
    splitSharesUncontrolled,
    splitSharesControlled,
    controlledUsageWeight,
    profileObservedMinUncontrolledKWh,
    profileObservedMinControlledKWh,
    observedPeakMarginRatio,
    usedInCurrent,
    remainingStartIndex,
    currentBucketIndex,
  } = params;
  const marginRatio = Number.isFinite(observedPeakMarginRatio)
    ? Math.max(0, observedPeakMarginRatio ?? 0)
    : OBSERVED_HOURLY_PEAK_MARGIN_RATIO;
  const weight = clamp(controlledUsageWeight, 0, 1);

  return bucketStartUtcMs
    .slice(remainingStartIndex)
    .map((bucketStartMs, index) => {
      const bucketIndex = remainingStartIndex + index;
      const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
      const uncontrolledMin = resolveObservedMin(profileObservedMinUncontrolledKWh?.[hour], marginRatio);
      const controlledMin = resolveObservedMin(profileObservedMinControlledKWh?.[hour], marginRatio);
      const blendedMin = blendObservedMins({
        uncontrolledMin,
        controlledMin,
        controlledUsageWeight: weight,
      });
      const shareUncontrolled = splitSharesUncontrolled[bucketIndex] ?? 1;
      const shareControlled = splitSharesControlled[bucketIndex] ?? 0;
      const blendedShare = blendSplitShare({
        shareUncontrolled,
        shareControlled,
        controlledUsageWeight: weight,
        includeUncontrolled: uncontrolledMin > 0,
        includeControlled: controlledMin > 0,
      });
      const totalFloorFromBlend = blendedShare > PLAN_CAP_EPSILON
        ? blendedMin / blendedShare
        : 0;
      if (bucketIndex === currentBucketIndex) {
        return Math.max(0, totalFloorFromBlend - usedInCurrent);
      }
      return Math.max(0, totalFloorFromBlend);
    });
}

export function buildControlledMinFloors(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  profileObservedMinControlledKWh?: number[];
  observedPeakMarginRatio?: number;
  applyFromIndex: number;
}): number[] {
  const {
    bucketStartUtcMs,
    timeZone,
    profileObservedMinControlledKWh,
    observedPeakMarginRatio,
    applyFromIndex,
  } = params;
  const marginRatio = Number.isFinite(observedPeakMarginRatio)
    ? Math.max(0, observedPeakMarginRatio ?? 0)
    : OBSERVED_HOURLY_PEAK_MARGIN_RATIO;
  return bucketStartUtcMs.map((bucketStartMs, index) => {
    if (index < applyFromIndex) return 0;
    const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
    return resolveObservedMin(profileObservedMinControlledKWh?.[hour], marginRatio);
  });
}

function resolveObservedCap(maxObserved: unknown, marginRatio: number): number {
  if (typeof maxObserved !== 'number' || !Number.isFinite(maxObserved) || maxObserved <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return maxObserved * (1 + marginRatio);
}

export function resolveObservedMin(minObserved: unknown, marginRatio: number): number {
  if (typeof minObserved !== 'number' || !Number.isFinite(minObserved) || minObserved <= 0) {
    return 0;
  }
  return Math.max(0, minObserved * (1 - marginRatio));
}

function blendObservedCaps(params: {
  uncontrolledCap: number;
  controlledCap: number;
  controlledUsageWeight: number;
}): number {
  const {
    uncontrolledCap,
    controlledCap,
    controlledUsageWeight,
  } = params;
  const blendWeights = resolveNormalizedBlendWeights({
    controlledUsageWeight,
    includeUncontrolled: Number.isFinite(uncontrolledCap),
    includeControlled: Number.isFinite(controlledCap),
  });
  if (!blendWeights) return Number.POSITIVE_INFINITY;
  const { uncontrolledWeight, controlledWeight } = blendWeights;
  let blendedCap = 0;
  if (uncontrolledWeight > 0) blendedCap += uncontrolledWeight * uncontrolledCap;
  if (controlledWeight > 0) blendedCap += controlledWeight * controlledCap;
  return blendedCap;
}

function blendObservedMins(params: {
  uncontrolledMin: number;
  controlledMin: number;
  controlledUsageWeight: number;
}): number {
  const {
    uncontrolledMin,
    controlledMin,
    controlledUsageWeight,
  } = params;
  const blendWeights = resolveNormalizedBlendWeights({
    controlledUsageWeight,
    includeUncontrolled: Number.isFinite(uncontrolledMin) && uncontrolledMin > 0,
    includeControlled: Number.isFinite(controlledMin) && controlledMin > 0,
  });
  if (!blendWeights) return 0;
  const { uncontrolledWeight, controlledWeight } = blendWeights;
  let blendedMin = 0;
  if (uncontrolledWeight > 0) blendedMin += uncontrolledWeight * uncontrolledMin;
  if (controlledWeight > 0) blendedMin += controlledWeight * controlledMin;
  return blendedMin;
}

function blendSplitShare(params: {
  shareUncontrolled: number;
  shareControlled: number;
  controlledUsageWeight: number;
  includeUncontrolled: boolean;
  includeControlled: boolean;
}): number {
  const {
    shareUncontrolled,
    shareControlled,
    controlledUsageWeight,
    includeUncontrolled,
    includeControlled,
  } = params;
  const blendWeights = resolveNormalizedBlendWeights({
    controlledUsageWeight,
    includeUncontrolled,
    includeControlled,
  });
  if (!blendWeights) return 0;
  const { uncontrolledWeight, controlledWeight } = blendWeights;
  return (
    uncontrolledWeight * shareUncontrolled
    + controlledWeight * shareControlled
  );
}

function resolveNormalizedBlendWeights(params: {
  controlledUsageWeight: number;
  includeUncontrolled: boolean;
  includeControlled: boolean;
}): { uncontrolledWeight: number; controlledWeight: number } | null {
  const { controlledUsageWeight, includeUncontrolled, includeControlled } = params;
  if (!includeUncontrolled && !includeControlled) return null;

  const weight = clamp(controlledUsageWeight, 0, 1);
  let uncontrolledWeight = includeUncontrolled ? (1 - weight) : 0;
  let controlledWeight = includeControlled ? weight : 0;
  let totalWeight = uncontrolledWeight + controlledWeight;

  // If the configured weight points entirely to a side without observed data,
  // fall back to the available side(s) instead of dropping bounds.
  if (totalWeight <= PLAN_CAP_EPSILON) {
    uncontrolledWeight = includeUncontrolled ? 1 : 0;
    controlledWeight = includeControlled ? 1 : 0;
    totalWeight = uncontrolledWeight + controlledWeight;
  }
  if (totalWeight <= PLAN_CAP_EPSILON) return null;

  return {
    uncontrolledWeight: uncontrolledWeight / totalWeight,
    controlledWeight: controlledWeight / totalWeight,
  };
}
