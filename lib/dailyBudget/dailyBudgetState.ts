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
import type { DailyBudgetSettings, DailyBudgetUiPayload } from './dailyBudgetTypes';

export type DayContext = {
  nowMs: number;
  timeZone: string;
  dateKey: string;
  dayStartUtcMs: number;
  bucketStartUtcMs: number[];
  bucketStartLocalLabels: string[];
  bucketKeys: string[];
  currentBucketIndex: number;
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
  const bucketKeys = bucketStartUtcMs.map((ts) => new Date(ts).toISOString());
  const currentBucketIndex = resolveCurrentBucketIndex(dayStartUtcMs, bucketStartUtcMs.length, nowMs);
  const bucketUsage = bucketKeys.map((key) => powerTracker.buckets?.[key] ?? 0);
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
    bucketUsage,
    usedNowKWh,
    currentBucketUsage,
  };
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
  const allowedCumKWh = buildAllowedCumKWh(plannedKWh, dailyBudgetKWh);
  const allowedNowKWh = enabled ? allowedCumKWh[context.currentBucketIndex] ?? 0 : 0;
  const remainingKWh = enabled ? dailyBudgetKWh - context.usedNowKWh : 0;
  const deviationKWh = enabled ? context.usedNowKWh - allowedNowKWh : 0;
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

export const buildDailyBudgetSnapshot = (params: {
  context: DayContext;
  settings: DailyBudgetSettings;
  enabled: boolean;
  plannedKWh: number[];
  priceData: PriceData;
  budget: BudgetState;
  pressure: number;
  frozen: boolean;
}): DailyBudgetUiPayload => {
  const {
    context,
    settings,
    enabled,
    plannedKWh,
    priceData,
    budget,
    pressure,
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
      aggressiveness: settings.aggressiveness,
      priceShapingEnabled: settings.priceShapingEnabled,
    },
    state: {
      usedNowKWh: context.usedNowKWh,
      allowedNowKWh: budget.allowedNowKWh,
      remainingKWh: budget.remainingKWh,
      pressure,
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
