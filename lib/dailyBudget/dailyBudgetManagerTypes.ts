import type { PriceData } from './dailyBudgetState';
import type { DailyBudgetState } from './dailyBudgetTypes';

export type DailyBudgetManagerDeps = {
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

export type ExistingPlanState = {
  planStateMismatch: boolean;
  existingPlan: number[] | null;
  deviationExisting: number;
};

export type PlanResult = {
  plannedKWh: number[];
  priceData: PriceData;
  shouldLog: boolean;
};

export const isDailyBudgetState = (value: unknown): value is DailyBudgetState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as DailyBudgetState;
  if (state.profile) {
    if (!Array.isArray(state.profile.weights) || state.profile.weights.length !== 24) return false;
    if (typeof state.profile.sampleCount !== 'number') return false;
  }
  if (state.plannedKWh && !Array.isArray(state.plannedKWh)) return false;
  return true;
};
