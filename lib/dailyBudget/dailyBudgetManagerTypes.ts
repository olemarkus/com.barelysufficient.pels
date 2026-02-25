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
  plannedUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  priceData: PriceData;
  shouldLog: boolean;
  planDebug?: {
    lockCurrentBucket: boolean;
    shouldLockCurrent: boolean;
    remainingStartIndex: number;
    hasPreviousPlan: boolean;
  };
};

const isValidProfile = (profile?: DailyBudgetState['profile']): boolean => {
  if (!profile) return true;
  if (
    !Array.isArray(profile.weights)
    || profile.weights.length !== 24
    || profile.weights.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) return false;
  if (
    typeof profile.sampleCount !== 'number'
    || !Number.isFinite(profile.sampleCount)
    || profile.sampleCount < 0
  ) return false;
  return true;
};

const isNumberOrUndefined = (value: unknown): boolean => (
  value === undefined || (typeof value === 'number' && Number.isFinite(value))
);

const isNonNegativeNumberOrUndefined = (value: unknown): boolean => (
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
);

const isBooleanOrUndefined = (value: unknown): boolean => (
  value === undefined || typeof value === 'boolean'
);

const isNullableStringOrUndefined = (value: unknown): boolean => (
  value === undefined || value === null || typeof value === 'string'
);

const isNullableFiniteNumberOrUndefined = (value: unknown): boolean => (
  value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
);

const isHourlyArrayOrUndefined = (value: unknown): boolean => (
  value === undefined
  || (Array.isArray(value)
    && value.length === 24
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))
);

export const isDailyBudgetState = (value: unknown): value is DailyBudgetState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as DailyBudgetState;
  const checks = [
    isValidProfile(state.profile)
    , isValidProfile(state.profileUncontrolled)
    , isValidProfile(state.profileControlled)
    , isNumberOrUndefined(state.profileControlledShare)
    , isNonNegativeNumberOrUndefined(state.profileSampleCount)
    , isNonNegativeNumberOrUndefined(state.profileSplitSampleCount)
    , isHourlyArrayOrUndefined(state.profileObservedMaxUncontrolledKWh)
    , isHourlyArrayOrUndefined(state.profileObservedMaxControlledKWh)
    , isHourlyArrayOrUndefined(state.profileObservedMinUncontrolledKWh)
    , isHourlyArrayOrUndefined(state.profileObservedMinControlledKWh)
    , isNullableStringOrUndefined(state.profileObservedStatsConfigKey)
    , (state.plannedKWh === undefined || (
      Array.isArray(state.plannedKWh)
      && state.plannedKWh.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ))
    , isNullableStringOrUndefined(state.dateKey)
    , isNullableFiniteNumberOrUndefined(state.dayStartUtcMs)
    , isNullableFiniteNumberOrUndefined(state.lastPlanBucketStartUtcMs)
    , isBooleanOrUndefined(state.frozen)
    , isNumberOrUndefined(state.lastUsedNowKWh),
  ];
  return checks.every(Boolean);
};
