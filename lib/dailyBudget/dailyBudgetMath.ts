import { getZonedParts } from '../utils/dateUtils';
import { clamp } from '../utils/mathUtils';
import type { DailyBudgetAggressiveness } from './dailyBudgetTypes';

export type CombinedPriceEntry = {
  startsAt: string;
  total: number;
};

export type CombinedPriceData = {
  prices?: CombinedPriceEntry[];
  lastFetched?: string;
};

const AGGRESSIVENESS_CONFIG: Record<DailyBudgetAggressiveness, { pressureScale: number; restoreExponent: number }> = {
  relaxed: { pressureScale: 0.2, restoreExponent: 0.7 },
  balanced: { pressureScale: 0.12, restoreExponent: 1 },
  strict: { pressureScale: 0.08, restoreExponent: 1.35 },
};
const PREVIOUS_PLAN_BLEND_WEIGHT = 0.7;
const NEW_PLAN_BLEND_WEIGHT = 1 - PREVIOUS_PLAN_BLEND_WEIGHT;

export function getConfidence(sampleCount: number): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0;
  return clamp(sampleCount / 14, 0, 1);
}

export function getAggressivenessConfig(aggressiveness: DailyBudgetAggressiveness): { pressureScale: number; restoreExponent: number } {
  return AGGRESSIVENESS_CONFIG[aggressiveness] ?? AGGRESSIVENESS_CONFIG.balanced;
}

export function blendProfiles(defaultWeights: number[], learnedWeights: number[], confidence: number): number[] {
  const safeConfidence = clamp(confidence, 0, 1);
  const blended = defaultWeights.map((value, index) => (
    value * (1 - safeConfidence) + (learnedWeights[index] ?? value) * safeConfidence
  ));
  return normalizeWeights(blended);
}

export function normalizeWeights(weights: number[]): number[] {
  const total = sumArray(weights);
  if (total <= 0) return weights.map(() => 0);
  return weights.map((value) => value / total);
}

export function buildDefaultProfile(): number[] {
  const bumps: Record<number, number> = {
    6: 0.3,
    7: 0.5,
    8: 0.4,
    16: 0.2,
    17: 0.5,
    18: 0.8,
    19: 0.9,
    20: 0.8,
    21: 0.6,
    22: 0.4,
  };
  const weights = Array.from({ length: 24 }, (_, hour) => 1 + (bumps[hour] ?? 0));
  return normalizeWeights(weights);
}

export function buildPlan(params: {
  bucketStartUtcMs: number[];
  bucketUsage: number[];
  currentBucketIndex: number;
  usedNowKWh: number;
  dailyBudgetKWh: number;
  profileWeights: number[];
  timeZone: string;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
  previousPlannedKWh?: number[];
}): {
  plannedKWh: number[];
  price?: Array<number | null>;
  priceFactor?: Array<number | null>;
  priceShapingActive: boolean;
} {
  const {
    bucketStartUtcMs,
    bucketUsage,
    currentBucketIndex,
    usedNowKWh,
    dailyBudgetKWh,
    profileWeights,
    timeZone,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
    previousPlannedKWh,
  } = params;

  const baseWeights = bucketStartUtcMs.map((ts) => {
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    return profileWeights[hour] ?? 0;
  });

  const priceShape = buildPriceFactors({
    bucketStartUtcMs,
    currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  });

  const remainingWeightsRaw = baseWeights.slice(currentBucketIndex);
  const remainingWeights = priceShape.priceFactors?.length
    ? remainingWeightsRaw.map((value, index) => {
      const factor = priceShape.priceFactors?.[currentBucketIndex + index];
      return typeof factor === 'number' ? value * factor : value;
    })
    : remainingWeightsRaw;

  let normalizedRemaining = normalizeWeights(remainingWeights);
  if (normalizedRemaining.every((value) => value === 0)) {
    const fallback = remainingWeights.map(() => 1);
    normalizedRemaining = normalizeWeights(fallback);
  }

  if (previousPlannedKWh && previousPlannedKWh.length === bucketStartUtcMs.length) {
    const previousRemaining = previousPlannedKWh.slice(currentBucketIndex);
    const previousWeights = normalizeWeights(previousRemaining);
    const blended = normalizedRemaining.map((value, index) => (
      previousWeights[index] !== undefined
        ? previousWeights[index] * PREVIOUS_PLAN_BLEND_WEIGHT + value * NEW_PLAN_BLEND_WEIGHT
        : value
    ));
    normalizedRemaining = normalizeWeights(blended);
  }

  const remainingBudget = Math.max(0, dailyBudgetKWh - usedNowKWh);
  const usedInCurrent = bucketUsage[currentBucketIndex] ?? 0;

  const plannedKWh = bucketStartUtcMs.map((_, index) => {
    if (index < currentBucketIndex) return bucketUsage[index] ?? 0;
    const weight = normalizedRemaining[index - currentBucketIndex] ?? 0;
    if (index === currentBucketIndex) return usedInCurrent + remainingBudget * weight;
    return remainingBudget * weight;
  });

  return {
    plannedKWh,
    price: priceShape.prices,
    priceFactor: priceShape.priceFactors,
    priceShapingActive: priceShape.priceShapingActive,
  };
}

export function buildPriceDebugData(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): { prices?: Array<number | null>; priceFactors?: Array<number | null>; priceShapingActive: boolean } {
  const priceShape = buildPriceFactors(params);
  if (!priceShape.priceFactors) {
    return { priceShapingActive: false };
  }
  return {
    prices: priceShape.prices,
    priceFactors: priceShape.priceFactors,
    priceShapingActive: priceShape.priceShapingActive,
  };
}

export function buildPriceFactors(params: {
  bucketStartUtcMs: number[];
  currentBucketIndex: number;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  priceShapingEnabled: boolean;
}): { prices?: Array<number | null>; priceFactors?: Array<number | null>; priceShapingActive: boolean } {
  const {
    bucketStartUtcMs,
    currentBucketIndex,
    combinedPrices,
    priceOptimizationEnabled,
    priceShapingEnabled,
  } = params;

  if (!priceOptimizationEnabled || !priceShapingEnabled) {
    return { priceShapingActive: false };
  }
  const entries = combinedPrices?.prices;
  if (!entries || entries.length === 0) {
    return { priceShapingActive: false };
  }
  const priceByStart = new Map<number, number>();
  entries.forEach((entry) => {
    const ts = new Date(entry.startsAt).getTime();
    if (Number.isFinite(ts)) priceByStart.set(ts, entry.total);
  });

  const pricesAll = bucketStartUtcMs.map((ts) => {
    const value = priceByStart.get(ts);
    return typeof value === 'number' ? value : null;
  });
  const remainingPrices = pricesAll.slice(currentBucketIndex);
  if (remainingPrices.some((value) => typeof value !== 'number')) {
    return { priceShapingActive: false };
  }
  const numericPrices = remainingPrices as number[];
  const priceList = [...numericPrices].sort((a, b) => a - b);
  const median = percentile(priceList, 0.5);
  const p10 = percentile(priceList, 0.1);
  const p90 = percentile(priceList, 0.9);
  const spread = Math.max(1, p90 - p10);
  const minFactor = 0.7;
  const maxFactor = 1.3;
  const remainingFactors = numericPrices.map((price) => clamp(1 + (median - price) / spread, minFactor, maxFactor));
  const priceFactorsAll = [
    ...Array.from({ length: currentBucketIndex }, () => null),
    ...remainingFactors,
  ];

  return {
    prices: pricesAll,
    priceFactors: priceFactorsAll,
    priceShapingActive: true,
  };
}

export function buildAllowedCumKWh(plannedKWh: number[], dailyBudgetKWh: number): number[] {
  if (dailyBudgetKWh <= 0) return plannedKWh.map(() => 0);
  let total = 0;
  return plannedKWh.map((value) => {
    total += value;
    return Math.min(total, dailyBudgetKWh);
  });
}

export function buildWeightsFromPlan(plannedKWh: number[]): number[] {
  const total = sumArray(plannedKWh);
  if (total <= 0) return plannedKWh.map(() => 0);
  return plannedKWh.map((value) => value / total);
}

export function resolveCurrentBucketIndex(dayStartUtcMs: number, bucketCount: number, nowMs: number): number {
  if (bucketCount <= 0) return 0;
  const diff = nowMs - dayStartUtcMs;
  const index = Math.floor(diff / (60 * 60 * 1000));
  return clamp(index, 0, bucketCount - 1);
}

export function sumArray(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * ratio)));
  return values[index];
}
