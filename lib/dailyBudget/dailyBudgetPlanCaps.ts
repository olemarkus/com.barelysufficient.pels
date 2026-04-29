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
      const observedTotalCap = sumAvailableCaps({
        uncontrolledCap,
        controlledCap,
      });
      const effectiveTotalCap = Math.min(capacityCap, observedTotalCap);
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
      const totalFloor = uncontrolledMin + weight * controlledMin;
      if (bucketIndex === currentBucketIndex) {
        return Math.max(0, totalFloor - usedInCurrent);
      }
      return Math.max(0, totalFloor);
    });
}

export function buildControlledMinFloors(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  profileObservedMinControlledKWh?: number[];
  observedPeakMarginRatio?: number;
  applyFromIndex: number;
  controlledUsageWeight?: number;
}): number[] {
  const {
    bucketStartUtcMs,
    timeZone,
    profileObservedMinControlledKWh,
    observedPeakMarginRatio,
    applyFromIndex,
    controlledUsageWeight,
  } = params;
  const marginRatio = Number.isFinite(observedPeakMarginRatio)
    ? Math.max(0, observedPeakMarginRatio ?? 0)
    : OBSERVED_HOURLY_PEAK_MARGIN_RATIO;
  const weight = clamp(controlledUsageWeight ?? 0, 0, 1);
  return bucketStartUtcMs.map((bucketStartMs, index) => {
    if (index < applyFromIndex) return 0;
    const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
    return weight * resolveObservedMin(profileObservedMinControlledKWh?.[hour], marginRatio);
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

function sumAvailableCaps(params: {
  uncontrolledCap: number;
  controlledCap: number;
}): number {
  const {
    uncontrolledCap,
    controlledCap,
  } = params;
  let totalCap = 0;
  if (Number.isFinite(uncontrolledCap)) totalCap += uncontrolledCap;
  if (Number.isFinite(controlledCap)) totalCap += controlledCap;
  if (totalCap <= PLAN_CAP_EPSILON) return Number.POSITIVE_INFINITY;
  return totalCap;
}
