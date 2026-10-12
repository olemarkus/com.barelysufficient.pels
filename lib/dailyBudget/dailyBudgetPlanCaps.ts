import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import { getZonedParts } from '../../packages/shared-domain/src/utils/dateUtils';
import { clamp } from '../../packages/shared-domain/src/utils/math';
import {
  CONTROLLED_USAGE_WEIGHT,
  OBSERVED_HOURLY_PEAK_MARGIN_RATIO,
  UNCONTROLLED_RESERVE_BASE_QUANTILE,
  UNCONTROLLED_RESERVE_DENOMINATOR_FLOOR_KWH,
  UNCONTROLLED_RESERVE_MAX_QUANTILE,
  UNCONTROLLED_RESERVE_MIN_KWH,
  UNCONTROLLED_RESERVE_TAIL_RATIO_FOR_MAX,
} from './dailyBudgetConstants';
import type { DayContext } from './dailyBudgetState';
import type { ObservedHourlyStats } from './observedHourlyStats';

const PLAN_CAP_EPSILON = 1e-6;

export type UncontrolledReserveHourDiagnostic = {
  hour: number;
  samples: number;
  p50: number;
  p75: number;
  p90: number;
  quantileUsed: number;
  reservedUncontrolledKWh: number;
  confidence: 'low' | 'medium' | 'high';
  reasonCode: 'median_default' | 'volatile_hour' | 'missing_data_fallback';
};

export type UncontrolledReservePlanDiagnostics = {
  totalReservedKWh: number;
  averageQuantile: number;
  lowConfidenceHours: number;
  volatileHours: number[];
  hours: UncontrolledReserveHourDiagnostic[];
};

export function resolveRemainingCaps(
  context: DayContext,
  observedStats: ObservedHourlyStats,
  planningCeiling: PowerLimitCeiling | null,
  usedInCurrent: number,
  remainingStartIndex: number,
  currentBucketIndex: number,
): number[] {
  const { bucketStartUtcMs, timeZone } = context;
  // Each bucket is one hour, so the ceiling's rate is also the hour's kWh. No
  // ceiling (no power limit enabled) leaves the observed-peak cap alone.
  const ceilingCap = planningCeiling === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, planningCeiling.kw);

  return bucketStartUtcMs
    .slice(remainingStartIndex)
    .map((bucketStartMs, index) => {
      const bucketIndex = remainingStartIndex + index;
      const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
      const uncontrolledCap = resolveObservedCap(observedStats.profileObservedMaxUncontrolledKWh[hour]);
      const controlledCap = resolveObservedCap(observedStats.profileObservedMaxControlledKWh[hour]);
      const observedTotalCap = sumAvailableCaps({
        uncontrolledCap,
        controlledCap,
      });
      const effectiveTotalCap = Math.min(ceilingCap, observedTotalCap);
      if (bucketIndex === currentBucketIndex) {
        return Math.max(0, effectiveTotalCap - usedInCurrent);
      }
      return Math.max(0, effectiveTotalCap);
    });
}

export function resolveRemainingFloors(
  context: DayContext,
  controlledUsageWeight: number,
  observedStats: ObservedHourlyStats,
  usedInCurrent: number,
  remainingStartIndex: number,
  currentBucketIndex: number,
): {
  floors: number[];
  uncontrolledReserves: number[];
  grossUncontrolledReserves: number[];
  grossUncontrolledReserveHasData: boolean[];
  diagnostics: UncontrolledReservePlanDiagnostics;
} {
  const {
    profileObservedMinUncontrolledKWh,
    profileObservedMinControlledKWh,
    profileObservedP50UncontrolledKWh,
    profileObservedP75UncontrolledKWh,
    profileObservedP90UncontrolledKWh,
    profileObservedUncontrolledSampleCounts,
    profileObservedGrossUncontrolledSampleCounts,
  } = observedStats;
  const reserveAggressiveness = clamp(controlledUsageWeight, 0, 1);
  const controlledFloorWeight = CONTROLLED_USAGE_WEIGHT;
  const remaining = context.bucketStartUtcMs.slice(remainingStartIndex).map((bucketStartMs) => {
    const hour = getZonedParts(new Date(bucketStartMs), context.timeZone).hour;
    const reserve = resolveUncontrolledReserve({
      hour,
      p50: profileObservedP50UncontrolledKWh[hour],
      p75: profileObservedP75UncontrolledKWh[hour],
      p90: profileObservedP90UncontrolledKWh[hour],
      samples: profileObservedUncontrolledSampleCounts[hour],
      fallbackMinObserved: profileObservedMinUncontrolledKWh[hour],
      reserveAggressiveness,
    });
    return { hour, reserve };
  });
  const floors = remaining.map(({ hour, reserve }, index) => {
    const controlledMin = resolveObservedMin(profileObservedMinControlledKWh[hour]);
    const totalFloor = reserve.reservedUncontrolledKWh + controlledFloorWeight * controlledMin;
    if (remainingStartIndex + index === currentBucketIndex) {
      return Math.max(0, totalFloor - usedInCurrent);
    }
    return Math.max(0, totalFloor);
  });
  return {
    floors,
    // Index-aligned with the day: elapsed (and locked) buckets reserve nothing.
    uncontrolledReserves: [
      ...Array.from({ length: remainingStartIndex }, () => 0),
      ...remaining.map(({ reserve }) => reserve.reservedUncontrolledKWh),
    ],
    grossUncontrolledReserves: buildGrossUncontrolledReserveFloors(
      context,
      observedStats,
      currentBucketIndex,
      reserveAggressiveness,
    ),
    grossUncontrolledReserveHasData: buildUncontrolledReserveDataPresence(
      context,
      profileObservedGrossUncontrolledSampleCounts,
      currentBucketIndex,
    ),
    diagnostics: summarizeUncontrolledReserveDiagnostics(remaining.map(({ reserve }) => reserve.diagnostic)),
  };
}

/**
 * The gross background reserve per bucket from `applyFromIndex` on, read off
 * the gross observed quantiles; earlier buckets reserve nothing.
 */
export function buildGrossUncontrolledReserveFloors(
  context: DayContext,
  observedStats: ObservedHourlyStats,
  applyFromIndex: number,
  reserveAggressiveness: number,
): number[] {
  return context.bucketStartUtcMs.map((bucketStartMs, index) => {
    if (index < applyFromIndex) return 0;
    const hour = getZonedParts(new Date(bucketStartMs), context.timeZone).hour;
    return resolveUncontrolledReserve({
      hour,
      p50: observedStats.profileObservedP50GrossUncontrolledKWh[hour],
      p75: observedStats.profileObservedP75GrossUncontrolledKWh[hour],
      p90: observedStats.profileObservedP90GrossUncontrolledKWh[hour],
      samples: observedStats.profileObservedGrossUncontrolledSampleCounts[hour],
      fallbackMinObserved: observedStats.profileObservedMinUncontrolledKWh[hour],
      reserveAggressiveness,
    }).reservedUncontrolledKWh;
  });
}

function buildUncontrolledReserveDataPresence(
  context: DayContext,
  profileObservedUncontrolledSampleCounts: number[],
  applyFromIndex: number,
): boolean[] {
  return context.bucketStartUtcMs.map((bucketStartMs, index) => {
    if (index < applyFromIndex) return false;
    const hour = getZonedParts(new Date(bucketStartMs), context.timeZone).hour;
    return normalizeSampleCount(profileObservedUncontrolledSampleCounts[hour]) > 0;
  });
}

export function buildControlledMinFloors(
  context: DayContext,
  profileObservedMinControlledKWh: number[],
  applyFromIndex: number,
): number[] {
  const weight = CONTROLLED_USAGE_WEIGHT;
  return context.bucketStartUtcMs.map((bucketStartMs, index) => {
    if (index < applyFromIndex) return 0;
    const hour = getZonedParts(new Date(bucketStartMs), context.timeZone).hour;
    return weight * resolveObservedMin(profileObservedMinControlledKWh[hour]);
  });
}

function resolveObservedCap(maxObserved: unknown): number {
  if (typeof maxObserved !== 'number' || !Number.isFinite(maxObserved) || maxObserved <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return maxObserved * (1 + OBSERVED_HOURLY_PEAK_MARGIN_RATIO);
}

function resolveObservedMin(minObserved: unknown): number {
  if (typeof minObserved !== 'number' || !Number.isFinite(minObserved) || minObserved <= 0) {
    return 0;
  }
  return Math.max(0, minObserved * (1 - OBSERVED_HOURLY_PEAK_MARGIN_RATIO));
}

export function resolveUncontrolledReserve(params: {
  hour: number;
  p50: unknown;
  p75: unknown;
  p90: unknown;
  samples: unknown;
  fallbackMinObserved?: unknown;
  reserveAggressiveness?: number;
}): { reservedUncontrolledKWh: number; diagnostic: UncontrolledReserveHourDiagnostic } {
  const { hour, p50, p75, p90, samples, fallbackMinObserved, reserveAggressiveness } = params;
  const sampleCount = normalizeSampleCount(samples);
  const reserveMode = clamp(reserveAggressiveness ?? 0, 0, 1);
  const baseQuantile = UNCONTROLLED_RESERVE_BASE_QUANTILE + 0.1 * reserveMode;
  const maxQuantile = UNCONTROLLED_RESERVE_MAX_QUANTILE + 0.1 * reserveMode;
  if (!isPositiveFinite(p50) || !isPositiveFinite(p75)) {
    const fallback = resolveObservedMin(fallbackMinObserved);
    return {
      reservedUncontrolledKWh: fallback,
      diagnostic: {
        hour,
        samples: sampleCount,
        p50: 0,
        p75: 0,
        p90: isPositiveFinite(p90) ? p90 : 0,
        quantileUsed: baseQuantile,
        reservedUncontrolledKWh: fallback,
        confidence: confidenceFromSamples(sampleCount),
        reasonCode: 'missing_data_fallback',
      },
    };
  }

  const safeP50 = p50;
  const safeP75 = Math.max(p75, safeP50);
  const safeP90 = isPositiveFinite(p90) ? Math.max(p90, safeP75) : safeP75;
  const relativeTail = (safeP90 - safeP50) / Math.max(safeP50, UNCONTROLLED_RESERVE_DENOMINATOR_FLOOR_KWH);
  const uncertainty = clamp(relativeTail / UNCONTROLLED_RESERVE_TAIL_RATIO_FOR_MAX, 0, 1);
  const quantileUsed = baseQuantile
    + (maxQuantile - baseQuantile) * uncertainty;
  const reserve = interpolateUncontrolledReserve(safeP50, safeP75, safeP90, quantileUsed);
  const reservedUncontrolledKWh = Math.min(
    safeP90,
    Math.max(UNCONTROLLED_RESERVE_MIN_KWH, reserve),
  );
  return {
    reservedUncontrolledKWh,
    diagnostic: {
      hour,
      samples: sampleCount,
      p50: safeP50,
      p75: safeP75,
      p90: safeP90,
      quantileUsed,
      reservedUncontrolledKWh,
      confidence: confidenceFromSamples(sampleCount),
      reasonCode: uncertainty > 0.2
        ? 'volatile_hour'
        : 'median_default',
    },
  };
}

function interpolateUncontrolledReserve(p50: number, p75: number, p90: number, quantile: number): number {
  if (quantile > UNCONTROLLED_RESERVE_MAX_QUANTILE) {
    const tailSpan = 0.90 - UNCONTROLLED_RESERVE_MAX_QUANTILE;
    if (tailSpan <= 0) return p75;
    const tailRatio = clamp((quantile - UNCONTROLLED_RESERVE_MAX_QUANTILE) / tailSpan, 0, 1);
    return p75 + (p90 - p75) * tailRatio;
  }
  const span = UNCONTROLLED_RESERVE_MAX_QUANTILE - UNCONTROLLED_RESERVE_BASE_QUANTILE;
  if (span <= 0) return p50;
  const ratio = clamp((quantile - UNCONTROLLED_RESERVE_BASE_QUANTILE) / span, 0, 1);
  return p50 + (p75 - p50) * ratio;
}

function summarizeUncontrolledReserveDiagnostics(
  hours: UncontrolledReserveHourDiagnostic[],
): UncontrolledReservePlanDiagnostics {
  const totalReservedKWh = hours.reduce((sum, hour) => sum + hour.reservedUncontrolledKWh, 0);
  const averageQuantile = hours.length > 0
    ? hours.reduce((sum, hour) => sum + hour.quantileUsed, 0) / hours.length
    : UNCONTROLLED_RESERVE_BASE_QUANTILE;
  return {
    totalReservedKWh,
    averageQuantile,
    lowConfidenceHours: hours.filter((hour) => hour.confidence === 'low').length,
    volatileHours: hours
      .filter((hour) => hour.reasonCode === 'volatile_hour')
      .map((hour) => hour.hour),
    hours,
  };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeSampleCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function confidenceFromSamples(samples: number): 'low' | 'medium' | 'high' {
  if (samples < 14) return 'low';
  if (samples < 28) return 'medium';
  return 'high';
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
