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
  getProfileBlendConfidence,
  resolveCurrentBucketIndex,
  sumArray,
} from './dailyBudgetMath';
import type { ConfidenceDebug, DailyBudgetDayPayload, DailyBudgetSettings } from './dailyBudgetTypes';

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
  // Budget control ignores exempt load, but reporting stays on real metered usage.
  budgetControlBucketUsage: number[];
  bucketUsageControlled?: Array<number | null>;
  bucketUsageUncontrolled?: Array<number | null>;
  bucketUsageExempt?: number[];
  usedNowKWh: number;
  budgetControlUsedNowKWh: number;
  meteredUsedNowKWh: number;
  exemptUsedNowKWh: number;
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
  profileBlendConfidence: number;
};

export type PriceData = {
  prices?: Array<number | null>;
  priceFactors?: Array<number | null>;
  priceShapingActive: boolean;
  priceSpreadFactor?: number;
  effectivePriceShapingFlexShare?: number;
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
    bucketUsageExempt,
  } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
  const currentBucketIndex = resolveCurrentBucketIndex(dayStartUtcMs, bucketStartUtcMs.length, nowMs);
  const currentBucketProgress = resolveBucketProgress({
    nowMs,
    bucketStartUtcMs,
    currentBucketIndex,
    nextDayStartUtcMs,
  });
  const {
    budgetControlBucketUsage,
    budgetControlUsedNowKWh,
    meteredUsedNowKWh,
    exemptUsedNowKWh,
    usedNowKWh,
  } = buildBudgetUsageViews({
    bucketUsage,
    bucketUsageExempt,
  });
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
    budgetControlBucketUsage,
    bucketUsageControlled,
    bucketUsageUncontrolled,
    bucketUsageExempt,
    usedNowKWh,
    budgetControlUsedNowKWh,
    meteredUsedNowKWh,
    exemptUsedNowKWh,
    currentBucketUsage,
  };
};

export const buildBudgetUsageViews = (params: {
  bucketUsage: number[];
  bucketUsageExempt?: number[];
}): {
  budgetControlBucketUsage: number[];
  budgetControlUsedNowKWh: number;
  meteredUsedNowKWh: number;
  exemptUsedNowKWh: number;
  usedNowKWh: number;
} => {
  const { bucketUsage, bucketUsageExempt } = params;
  const budgetControlBucketUsage = bucketUsage.map((value, index) => {
    const total = Math.max(0, value);
    const exempt = clamp(bucketUsageExempt?.[index] ?? 0, 0, total);
    return Math.max(0, total - exempt);
  });
  const meteredUsedNowKWh = sumArray(bucketUsage);
  const exemptUsedNowKWh = sumArray(bucketUsage.map((value, index) => (
    clamp(bucketUsageExempt?.[index] ?? 0, 0, Math.max(0, value))
  )));
  const budgetControlUsedNowKWh = sumArray(budgetControlBucketUsage);

  return {
    budgetControlBucketUsage,
    budgetControlUsedNowKWh,
    meteredUsedNowKWh,
    exemptUsedNowKWh,
    usedNowKWh: meteredUsedNowKWh,
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
  bucketUsageExempt?: number[];
} => {
  const { bucketStartUtcMs, powerTracker } = params;
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const bucketUsage = bucketKeys.map((key) => powerTracker.buckets?.[key] ?? 0);
  const controlledRaw = powerTracker.controlledBuckets ?? {};
  const uncontrolledRaw = powerTracker.uncontrolledBuckets ?? {};
  const exemptRaw = powerTracker.exemptBuckets ?? {};
  const splitUsage = bucketKeys.map((key, index) => {
    const total = Math.max(0, bucketUsage[index] ?? 0);
    const rawControlled = controlledRaw[key];
    const rawUncontrolled = uncontrolledRaw[key];
    const rawExempt = exemptRaw[key];
    const hasControlled = typeof rawControlled === 'number' && Number.isFinite(rawControlled);
    const hasUncontrolled = typeof rawUncontrolled === 'number' && Number.isFinite(rawUncontrolled);
    const exempt = typeof rawExempt === 'number' && Number.isFinite(rawExempt)
      ? clamp(rawExempt, 0, total)
      : 0;

    if (!hasControlled && !hasUncontrolled) {
      return { controlled: null, uncontrolled: null };
    }

    if (hasControlled) {
      // Exempt load stays in the uncontrolled side of budget learning/breakdown even
      // if the device is still capacity-controllable at runtime.
      const controlled = clamp((rawControlled as number) - exempt, 0, total);
      return {
        controlled,
        uncontrolled: Math.max(0, total - controlled),
      };
    }

    return {
      controlled: 0,
      uncontrolled: total,
    };
  });
  const bucketUsageControlled = splitUsage.map((entry) => entry.controlled);
  const bucketUsageUncontrolled = splitUsage.map((entry) => entry.uncontrolled);
  const bucketUsageExempt = bucketKeys.map((key, index) => {
    const rawExempt = exemptRaw[key];
    const exempt = typeof rawExempt === 'number' && Number.isFinite(rawExempt) ? rawExempt : 0;
    return clamp(exempt, 0, Math.max(0, bucketUsage[index] ?? 0));
  });
  const hasSplit = bucketUsageControlled.some((value) => typeof value === 'number')
    || bucketUsageUncontrolled.some((value) => typeof value === 'number');
  const hasExempt = bucketUsageExempt.some((value) => value > 0);
  return {
    bucketKeys,
    bucketUsage,
    bucketUsageControlled: hasSplit ? bucketUsageControlled : undefined,
    bucketUsageUncontrolled: hasSplit ? bucketUsageUncontrolled : undefined,
    bucketUsageExempt: hasExempt ? bucketUsageExempt : undefined,
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
  const baseConfidence = getProfileBlendConfidence(profileSampleCount);
  const splitConfidence = typeof profileSplitSampleCount === 'number'
    ? getProfileBlendConfidence(profileSplitSampleCount)
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
    profileBlendConfidence: baseConfidence,
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
  confidenceDebug?: ConfidenceDebug;
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
    confidenceDebug,
  } = params;
  const allocationPressure = computeAllocationPressure({
    dailyBudgetKWh: settings.dailyBudgetKWh,
    enabled,
    context,
    plannedKWh,
  });

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
      allocationPressure,
      confidenceDebug,
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

function computeAllocationPressure(params: {
  dailyBudgetKWh: number;
  enabled: boolean;
  context: DayContext;
  plannedKWh: number[];
}) {
  const { dailyBudgetKWh, enabled, context, plannedKWh } = params;
  if (context.currentBucketIndex >= plannedKWh.length) {
    return {
      requestedBudgetKWh: 0,
      plannedBudgetKWh: 0,
      unallocatedBudgetKWh: 0,
      saturationRatio: 1,
      constrained: false,
    };
  }

  const requestedBudgetKWh = Number.isFinite(dailyBudgetKWh)
    ? Math.max(0, dailyBudgetKWh - context.budgetControlUsedNowKWh)
    : 0;
  const plannedBudgetKWh = computeRemainingPlannedBudget({
    context,
    plannedKWh,
  });
  const unallocatedBudgetKWh = Math.max(0, requestedBudgetKWh - plannedBudgetKWh);
  const saturationRatio = requestedBudgetKWh > 0
    ? Math.min(1, plannedBudgetKWh / requestedBudgetKWh)
    : 1;
  const meaningfulGapKWh = Math.max(1, requestedBudgetKWh * 0.05);
  return {
    requestedBudgetKWh,
    plannedBudgetKWh,
    unallocatedBudgetKWh,
    saturationRatio,
    constrained: enabled && unallocatedBudgetKWh > meaningfulGapKWh,
  };
}

function computeRemainingPlannedBudget(params: {
  context: DayContext;
  plannedKWh: number[];
}): number {
  const { context, plannedKWh } = params;
  const startIndex = Math.max(0, context.currentBucketIndex);
  let total = 0;
  for (let index = startIndex; index < plannedKWh.length; index += 1) {
    const value = plannedKWh[index];
    const planned = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (index === startIndex) {
      const usedInCurrent = context.budgetControlBucketUsage[startIndex] ?? 0;
      total += Math.max(0, planned - Math.max(0, usedInCurrent));
    } else {
      total += planned;
    }
  }
  return total;
}
