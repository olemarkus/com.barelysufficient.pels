import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import {
  buildAllowedCumKWh,
  buildWeightsFromPlan,
  getConfidence,
  resolveCurrentBucketIndex,
  sumArray,
} from './dailyBudgetMath';
import type { DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

export type DayContext = {
  nowMs: number;
  timeZone: string;
  dateKey: string;
  dayStartUtcMs: number;
  bucketStartUtcMs: number[];
  bucketStartLocalLabels: string[];
  bucketKeys: string[];
  currentBucketIndex: number;
  currentBucketProgress: number;
  bucketUsage: number[];
  usedNowKWh: number;
  currentBucketUsage: number;
};

export type BudgetState = {
  plannedWeight: number[];
  allowedCumKWh: number[];
  allowedNowKWh: number;
  remainingKWh: number;
  deviationKWh: number;
  exceeded: boolean;
  confidence: number;
};

export type PriceData = {
  prices?: Array<number | null>;
  priceFactors?: Array<number | null>;
  priceShapingActive: boolean;
};

export const buildDayContext = (params: {
  nowMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
}): DayContext => {
  const { nowMs, timeZone, powerTracker } = params;
  const dateKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs, bucketStartLocalLabels } = buildLocalDayBuckets({
    dayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });
  const { bucketKeys, bucketUsage } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
  const currentBucketIndex = resolveCurrentBucketIndex(dayStartUtcMs, bucketStartUtcMs.length, nowMs);
  const currentBucketProgress = resolveBucketProgress({
    nowMs,
    bucketStartUtcMs,
    currentBucketIndex,
    nextDayStartUtcMs,
  });
  const usedNowKWh = sumArray(bucketUsage);
  const currentBucketUsage = bucketUsage[currentBucketIndex] ?? 0;

  return {
    nowMs,
    timeZone,
    dateKey,
    dayStartUtcMs,
    bucketStartUtcMs,
    bucketStartLocalLabels,
    bucketKeys,
    currentBucketIndex,
    currentBucketProgress,
    bucketUsage,
    usedNowKWh,
    currentBucketUsage,
  };
};

export const buildBucketUsage = (params: {
  bucketStartUtcMs: number[];
  powerTracker: PowerTrackerState;
}): { bucketKeys: string[]; bucketUsage: number[] } => {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const bucketUsage = bucketKeys.map((key) => powerTracker.buckets?.[key] ?? 0);
  return { bucketKeys, bucketUsage };
};

export const computePlanDeviation = (params: {
  enabled: boolean;
  plannedKWh: number[];
  dailyBudgetKWh: number;
  currentBucketIndex: number;
  currentBucketProgress: number;
  usedNowKWh: number;
}): { allowedCumKWh: number[]; allowedNowKWh: number; deviationKWh: number } => {
  const {
    enabled,
    plannedKWh,
    dailyBudgetKWh,
    currentBucketIndex,
    currentBucketProgress,
    usedNowKWh,
  } = params;
  const allowedCumKWh = buildAllowedCumKWh(plannedKWh, dailyBudgetKWh);
  const allowedNowKWh = enabled
    ? interpolateAllowedNowKWh(allowedCumKWh, currentBucketIndex, currentBucketProgress)
    : 0;
  const deviationKWh = enabled ? usedNowKWh - allowedNowKWh : 0;
  return { allowedCumKWh, allowedNowKWh, deviationKWh };
};

export const computeBudgetState = (params: {
  context: DayContext;
  enabled: boolean;
  dailyBudgetKWh: number;
  plannedKWh: number[];
  profileSampleCount: number;
}): BudgetState => {
  const {
    context,
    enabled,
    dailyBudgetKWh,
    plannedKWh,
    profileSampleCount,
  } = params;
  const plannedWeight = buildWeightsFromPlan(plannedKWh);
  const { allowedCumKWh, allowedNowKWh, deviationKWh } = computePlanDeviation({
    enabled,
    plannedKWh,
    dailyBudgetKWh,
    currentBucketIndex: context.currentBucketIndex,
    currentBucketProgress: context.currentBucketProgress,
    usedNowKWh: context.usedNowKWh,
  });
  const remainingKWh = enabled ? dailyBudgetKWh - context.usedNowKWh : 0;
  const confidence = getConfidence(profileSampleCount);
  const exceeded = enabled && (context.usedNowKWh > dailyBudgetKWh || deviationKWh > 0);

  return {
    plannedWeight,
    allowedCumKWh,
    allowedNowKWh,
    remainingKWh,
    deviationKWh,
    exceeded,
    confidence,
  };
};

function interpolateAllowedNowKWh(
  allowedCumKWh: number[],
  currentBucketIndex: number,
  currentBucketProgress: number,
): number {
  if (currentBucketIndex <= 0) {
    const first = allowedCumKWh[0] ?? 0;
    return first * clamp(currentBucketProgress, 0, 1);
  }
  const prev = allowedCumKWh[currentBucketIndex - 1] ?? 0;
  const current = allowedCumKWh[currentBucketIndex] ?? prev;
  const progress = clamp(currentBucketProgress, 0, 1);
  return prev + (current - prev) * progress;
}

function resolveBucketProgress(params: {
  nowMs: number;
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  nextDayStartUtcMs: number;
}): number {
  const { nowMs, bucketStartUtcMs, currentBucketIndex, nextDayStartUtcMs } = params;
  const clampedIndex = Math.max(0, Math.min(currentBucketIndex, bucketStartUtcMs.length - 1));
  const start = bucketStartUtcMs[clampedIndex] ?? nowMs;
  const end = bucketStartUtcMs[clampedIndex + 1] ?? nextDayStartUtcMs;
  const span = Math.max(1, end - start);
  return clamp((nowMs - start) / span, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const buildDailyBudgetSnapshot = (params: {
  context: DayContext;
  settings: DailyBudgetSettings;
  enabled: boolean;
  plannedKWh: number[];
  priceData: PriceData;
  budget: BudgetState;
  frozen: boolean;
}): DailyBudgetDayPayload => {
  const {
    context,
    settings,
    enabled,
    plannedKWh,
    priceData,
    budget,
    frozen,
  } = params;

  return {
    dateKey: context.dateKey,
    timeZone: context.timeZone,
    nowUtc: new Date(context.nowMs).toISOString(),
    dayStartUtc: new Date(context.dayStartUtcMs).toISOString(),
    currentBucketIndex: context.currentBucketIndex,
    budget: {
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      priceShapingEnabled: settings.priceShapingEnabled,
    },
    state: {
      usedNowKWh: context.usedNowKWh,
      allowedNowKWh: budget.allowedNowKWh,
      remainingKWh: budget.remainingKWh,
      deviationKWh: budget.deviationKWh,
      exceeded: budget.exceeded,
      frozen,
      confidence: budget.confidence,
      priceShapingActive: priceData.priceShapingActive,
    },
    buckets: {
      startUtc: context.bucketKeys,
      startLocalLabels: context.bucketStartLocalLabels,
      plannedWeight: budget.plannedWeight,
      plannedKWh,
      actualKWh: context.bucketUsage,
      allowedCumKWh: budget.allowedCumKWh,
      price: priceData.prices,
      priceFactor: priceData.priceFactors,
    },
  };
};
