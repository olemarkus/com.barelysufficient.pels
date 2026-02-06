import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import { clamp } from '../utils/mathUtils';
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
  bucketUsageControlled?: Array<number | null>;
  bucketUsageUncontrolled?: Array<number | null>;
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
  const {
    bucketKeys,
    bucketUsage,
    bucketUsageControlled,
    bucketUsageUncontrolled,
  } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
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
    bucketUsageControlled,
    bucketUsageUncontrolled,
    usedNowKWh,
    currentBucketUsage,
  };
};

export const buildBucketUsage = (params: {
  bucketStartUtcMs: number[];
  powerTracker: PowerTrackerState;
}): {
  bucketKeys: string[];
  bucketUsage: number[];
  bucketUsageControlled?: Array<number | null>;
  bucketUsageUncontrolled?: Array<number | null>;
} => {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const bucketUsage = bucketKeys.map((key) => powerTracker.buckets?.[key] ?? 0);
  const controlledRaw = powerTracker.controlledBuckets ?? {};
  const uncontrolledRaw = powerTracker.uncontrolledBuckets ?? {};
  const splitUsage = bucketKeys.map((key, index) => {
    const total = Math.max(0, bucketUsage[index] ?? 0);
    const rawControlled = controlledRaw[key];
    const rawUncontrolled = uncontrolledRaw[key];
    const hasControlled = typeof rawControlled === 'number' && Number.isFinite(rawControlled);
    const hasUncontrolled = typeof rawUncontrolled === 'number' && Number.isFinite(rawUncontrolled);

    if (!hasControlled && !hasUncontrolled) {
      return { controlled: null, uncontrolled: null };
    }

    if (hasControlled) {
      const controlled = clamp(rawControlled as number, 0, total);
      return {
        controlled,
        uncontrolled: Math.max(0, total - controlled),
      };
    }

    const uncontrolled = clamp(rawUncontrolled as number, 0, total);
    return {
      controlled: Math.max(0, total - uncontrolled),
      uncontrolled,
    };
  });
  const bucketUsageControlled = splitUsage.map((entry) => entry.controlled);
  const bucketUsageUncontrolled = splitUsage.map((entry) => entry.uncontrolled);
  const hasSplit = bucketUsageControlled.some((value) => typeof value === 'number')
    || bucketUsageUncontrolled.some((value) => typeof value === 'number');
  return {
    bucketKeys,
    bucketUsage,
    bucketUsageControlled: hasSplit ? bucketUsageControlled : undefined,
    bucketUsageUncontrolled: hasSplit ? bucketUsageUncontrolled : undefined,
  };
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
  profileSplitSampleCount?: number;
}): BudgetState => {
  const {
    context,
    enabled,
    dailyBudgetKWh,
    plannedKWh,
    profileSampleCount,
    profileSplitSampleCount,
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
  const baseConfidence = getConfidence(profileSampleCount);
  const splitConfidence = typeof profileSplitSampleCount === 'number'
    ? getConfidence(profileSplitSampleCount)
    : baseConfidence;
  const confidence = Math.min(baseConfidence, splitConfidence);
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
  if (bucketStartUtcMs.length === 0) return 0;
  const clampedIndex = Math.max(0, Math.min(currentBucketIndex, bucketStartUtcMs.length - 1));
  const start = bucketStartUtcMs[clampedIndex];
  const end = bucketStartUtcMs[clampedIndex + 1] ?? nextDayStartUtcMs;
  return clamp((nowMs - start) / Math.max(1, end - start), 0, 1);
}

export const buildDailyBudgetSnapshot = (params: {
  context: DayContext;
  settings: DailyBudgetSettings;
  enabled: boolean;
  plannedKWh: number[];
  plannedUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  priceData: PriceData;
  budget: BudgetState;
  frozen: boolean;
}): DailyBudgetDayPayload => {
  const {
    context,
    settings,
    enabled,
    plannedKWh,
    plannedUncontrolledKWh,
    plannedControlledKWh,
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
      plannedUncontrolledKWh,
      plannedControlledKWh,
      actualKWh: context.bucketUsage,
      actualControlledKWh: context.bucketUsageControlled,
      actualUncontrolledKWh: context.bucketUsageUncontrolled,
      allowedCumKWh: budget.allowedCumKWh,
      price: priceData.prices,
      priceFactor: priceData.priceFactors,
    },
  };
};
