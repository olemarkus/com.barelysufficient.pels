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

const isValidProfile = (profile?: DailyBudgetState['profile']): boolean => {
  if (!profile) return true;
  if (!Array.isArray(profile.weights) || profile.weights.length !== 24) return false;
  if (typeof profile.sampleCount !== 'number') return false;
  return true;
};

const isNumberOrUndefined = (value: unknown): boolean => (
  value === undefined || typeof value === 'number'
);

export const isDailyBudgetState = (value: unknown): value is DailyBudgetState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as DailyBudgetState;
  return (
    isValidProfile(state.profile)
    && isValidProfile(state.profileUncontrolled)
    && isValidProfile(state.profileControlled)
    && isNumberOrUndefined(state.profileControlledShare)
    && isNumberOrUndefined(state.profileSampleCount)
    && isNumberOrUndefined(state.profileSplitSampleCount)
    && (!state.plannedKWh || Array.isArray(state.plannedKWh))
  );
};
