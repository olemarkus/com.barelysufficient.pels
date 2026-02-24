import { clamp } from '../utils/mathUtils';
import { normalizeWeights } from './dailyBudgetAllocation';
import {
  allocateBudgetWithCaps,
  allocateBudgetWithCapsAndFloors,
  buildCompositeWeights,
} from './dailyBudgetAllocation';
import { buildPlan } from './dailyBudgetPlanCore';

export function getConfidence(sampleCount: number): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0;
  return clamp(sampleCount / 14, 0, 1);
}


export function blendProfiles(defaultWeights: number[], learnedWeights: number[], confidence: number): number[] {
  const safeConfidence = clamp(confidence, 0, 1);
  const blended = defaultWeights.map((value, index) => (
    value * (1 - safeConfidence) + (learnedWeights[index] ?? value) * safeConfidence
  ));
  return normalizeWeights(blended);
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

export {
  allocateBudgetWithCaps,
  allocateBudgetWithCapsAndFloors,
  buildCompositeWeights,
  buildPlan,
  normalizeWeights,
};
export { buildPriceDebugData, buildPriceFactors, buildPriceSeries } from './dailyBudgetPrices';
export type { CombinedPriceData, CombinedPriceEntry } from './dailyBudgetPrices';
