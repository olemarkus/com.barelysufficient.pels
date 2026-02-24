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
      const weightedShare = (1 - weight) * shareUncontrolled + weight * shareControlled;
      const totalCapFromBlend = Number.isFinite(blendedCap) && weightedShare > PLAN_CAP_EPSILON
        ? blendedCap / weightedShare
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
      const weightedShare = (1 - weight) * shareUncontrolled + weight * shareControlled;
      const totalFloorFromBlend = weightedShare > PLAN_CAP_EPSILON
        ? blendedMin / weightedShare
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
  const weight = clamp(controlledUsageWeight, 0, 1);
  const uncontrolledWeight = 1 - weight;
  let weightedCap = 0;
  let totalWeight = 0;
  if (Number.isFinite(uncontrolledCap) && uncontrolledWeight > 0) {
    weightedCap += uncontrolledWeight * uncontrolledCap;
    totalWeight += uncontrolledWeight;
  }
  if (Number.isFinite(controlledCap) && weight > 0) {
    weightedCap += weight * controlledCap;
    totalWeight += weight;
  }
  if (totalWeight <= PLAN_CAP_EPSILON) return Number.POSITIVE_INFINITY;
  return weightedCap / totalWeight;
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
  const weight = clamp(controlledUsageWeight, 0, 1);
  const uncontrolledWeight = 1 - weight;
  let weightedMin = 0;
  let totalWeight = 0;
  if (Number.isFinite(uncontrolledMin) && uncontrolledMin > 0 && uncontrolledWeight > 0) {
    weightedMin += uncontrolledWeight * uncontrolledMin;
    totalWeight += uncontrolledWeight;
  }
  if (Number.isFinite(controlledMin) && controlledMin > 0 && weight > 0) {
    weightedMin += weight * controlledMin;
    totalWeight += weight;
  }
  if (totalWeight <= PLAN_CAP_EPSILON) return 0;
  return weightedMin / totalWeight;
}
