import { getZonedParts } from '../utils/dateUtils';
import { clamp } from '../utils/mathUtils';
import {
  OBSERVED_HOURLY_PEAK_MARGIN_RATIO,
  UNCONTROLLED_RESERVE_BASE_QUANTILE,
  UNCONTROLLED_RESERVE_DENOMINATOR_FLOOR_KWH,
  UNCONTROLLED_RESERVE_MAX_QUANTILE,
  UNCONTROLLED_RESERVE_MIN_KWH,
  UNCONTROLLED_RESERVE_TAIL_RATIO_FOR_MAX,
} from './dailyBudgetConstants';

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
  profileObservedP50UncontrolledKWh?: number[];
  profileObservedP75UncontrolledKWh?: number[];
  profileObservedP90UncontrolledKWh?: number[];
  profileObservedUncontrolledSampleCounts?: number[];
  observedPeakMarginRatio?: number;
  usedInCurrent: number;
  remainingStartIndex: number;
  currentBucketIndex: number;
}): { floors: number[]; uncontrolledReserves: number[]; diagnostics: UncontrolledReservePlanDiagnostics } {
  const {
    bucketStartUtcMs,
    timeZone,
    controlledUsageWeight,
    profileObservedMinUncontrolledKWh,
    profileObservedMinControlledKWh,
    profileObservedP50UncontrolledKWh,
    profileObservedP75UncontrolledKWh,
    profileObservedP90UncontrolledKWh,
    profileObservedUncontrolledSampleCounts,
    observedPeakMarginRatio,
    usedInCurrent,
    remainingStartIndex,
    currentBucketIndex,
  } = params;
  const marginRatio = Number.isFinite(observedPeakMarginRatio)
    ? Math.max(0, observedPeakMarginRatio ?? 0)
    : OBSERVED_HOURLY_PEAK_MARGIN_RATIO;
  const weight = clamp(controlledUsageWeight, 0, 1);
  const diagnosticsHours: UncontrolledReserveHourDiagnostic[] = [];

  const floors = bucketStartUtcMs
    .slice(remainingStartIndex)
    .map((bucketStartMs, index) => {
      const bucketIndex = remainingStartIndex + index;
      const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
      const reserve = resolveUncontrolledReserve({
        hour,
        p50: profileObservedP50UncontrolledKWh?.[hour],
        p75: profileObservedP75UncontrolledKWh?.[hour],
        p90: profileObservedP90UncontrolledKWh?.[hour],
        samples: profileObservedUncontrolledSampleCounts?.[hour],
        fallbackMinObserved: profileObservedMinUncontrolledKWh?.[hour],
        marginRatio,
      });
      diagnosticsHours.push(reserve.diagnostic);
      const controlledMin = resolveObservedMin(profileObservedMinControlledKWh?.[hour], marginRatio);
      const totalFloor = reserve.reservedUncontrolledKWh + weight * controlledMin;
      if (bucketIndex === currentBucketIndex) {
        return Math.max(0, totalFloor - usedInCurrent);
      }
      return Math.max(0, totalFloor);
    });
  const uncontrolledReserves = buildUncontrolledReserveFloors({
    bucketStartUtcMs,
    timeZone,
    profileObservedMinUncontrolledKWh,
    profileObservedP50UncontrolledKWh,
    profileObservedP75UncontrolledKWh,
    profileObservedP90UncontrolledKWh,
    profileObservedUncontrolledSampleCounts,
    observedPeakMarginRatio,
    applyFromIndex: remainingStartIndex,
  });
  return {
    floors,
    uncontrolledReserves,
    diagnostics: summarizeUncontrolledReserveDiagnostics(diagnosticsHours),
  };
}

export function buildUncontrolledReserveFloors(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  profileObservedMinUncontrolledKWh?: number[];
  profileObservedP50UncontrolledKWh?: number[];
  profileObservedP75UncontrolledKWh?: number[];
  profileObservedP90UncontrolledKWh?: number[];
  profileObservedUncontrolledSampleCounts?: number[];
  observedPeakMarginRatio?: number;
  applyFromIndex: number;
}): number[] {
  const {
    bucketStartUtcMs,
    timeZone,
    profileObservedMinUncontrolledKWh,
    profileObservedP50UncontrolledKWh,
    profileObservedP75UncontrolledKWh,
    profileObservedP90UncontrolledKWh,
    profileObservedUncontrolledSampleCounts,
    observedPeakMarginRatio,
    applyFromIndex,
  } = params;
  const marginRatio = Number.isFinite(observedPeakMarginRatio)
    ? Math.max(0, observedPeakMarginRatio ?? 0)
    : OBSERVED_HOURLY_PEAK_MARGIN_RATIO;
  return bucketStartUtcMs.map((bucketStartMs, index) => {
    if (index < applyFromIndex) return 0;
    const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
    return resolveUncontrolledReserve({
      hour,
      p50: profileObservedP50UncontrolledKWh?.[hour],
      p75: profileObservedP75UncontrolledKWh?.[hour],
      p90: profileObservedP90UncontrolledKWh?.[hour],
      samples: profileObservedUncontrolledSampleCounts?.[hour],
      fallbackMinObserved: profileObservedMinUncontrolledKWh?.[hour],
      marginRatio,
    }).reservedUncontrolledKWh;
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

export function resolveUncontrolledReserve(params: {
  hour: number;
  p50: unknown;
  p75: unknown;
  p90: unknown;
  samples: unknown;
  fallbackMinObserved?: unknown;
  marginRatio: number;
}): { reservedUncontrolledKWh: number; diagnostic: UncontrolledReserveHourDiagnostic } {
  const { hour, p50, p75, p90, samples, fallbackMinObserved, marginRatio } = params;
  const sampleCount = normalizeSampleCount(samples);
  if (!isPositiveFinite(p50) || !isPositiveFinite(p75)) {
    const fallback = resolveObservedMin(fallbackMinObserved, marginRatio);
    return {
      reservedUncontrolledKWh: fallback,
      diagnostic: {
        hour,
        samples: sampleCount,
        p50: 0,
        p75: 0,
        p90: isPositiveFinite(p90) ? p90 : 0,
        quantileUsed: UNCONTROLLED_RESERVE_BASE_QUANTILE,
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
  const quantileUsed = UNCONTROLLED_RESERVE_BASE_QUANTILE
    + (UNCONTROLLED_RESERVE_MAX_QUANTILE - UNCONTROLLED_RESERVE_BASE_QUANTILE) * uncertainty;
  const reserve = interpolateReserveBetweenP50AndP75({
    p50: safeP50,
    p75: safeP75,
    quantile: quantileUsed,
  });
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
      reasonCode: quantileUsed > UNCONTROLLED_RESERVE_BASE_QUANTILE + 0.05
        ? 'volatile_hour'
        : 'median_default',
    },
  };
}

function interpolateReserveBetweenP50AndP75(params: {
  p50: number;
  p75: number;
  quantile: number;
}): number {
  const { p50, p75, quantile } = params;
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
