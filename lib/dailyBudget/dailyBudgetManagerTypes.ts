import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../power/tracker';
import type { CombinedPriceData } from './dailyBudgetMath';
import type { UncontrolledReservePlanDiagnostics } from './dailyBudgetPlanCaps';
import type { PriceData } from './dailyBudgetState';
import type {
  DailyBudgetSettings,
  DailyBudgetState,
  DailyBudgetStatePersistReason,
} from './dailyBudgetTypes';
import { OBSERVED_HOURLY_STATS_FIELDS } from './observedHourlyStats';

export type DailyBudgetManagerDeps = {
  log: (...args: unknown[]) => void;
  isDebugTopicEnabled?: (topic: 'daily_budget') => boolean;
  structuredDebug?: (payload: Record<string, unknown>) => void;
  // Topic-gated (`daily_budget`) structured debug for discrete lifecycle events
  // (freeze/unfreeze/recompute/learning). Distinct from `structuredDebug`, which
  // is gated on confidence-bootstrap only.
  debugStructured?: import('../logging/logger').StructuredDebugEmitter;
};

export type ExistingPlanState = {
  planStateMismatch: boolean;
  existingPlan: number[] | null;
  deviationExisting: number;
};

export type RebuildPlanDebug = {
  lockCurrentBucket: boolean;
  shouldLockCurrent: boolean;
  remainingStartIndex: number;
  hasPreviousPlan: boolean;
};

export type DailyBudgetUpdateParams = {
  nowMs?: number;
  timeZone: string;
  settings: DailyBudgetSettings;
  powerTracker: PowerTrackerState;
  combinedPrices?: CombinedPriceData | null;
  priceOptimizationEnabled: boolean;
  forcePlanRebuild?: boolean;
  planningCeiling: PowerLimitCeiling | null;
  refreshObservedStats?: boolean;
  refreshConfidence?: boolean;
  includeConfidenceBootstrapDebug?: boolean;
  recomputeFrozenPlan?: boolean;
  persistReason?: DailyBudgetStatePersistReason;
};

export type PlanResult = {
  plannedKWh: number[];
  plannedUncontrolledKWh?: number[];
  plannedGrossUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  priceData: PriceData;
  shouldLog: boolean;
  planDebug?: RebuildPlanDebug;
  uncontrolledReserveDiagnostics?: UncontrolledReservePlanDiagnostics;
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

const isFiniteNumberArrayOrUndefined = (value: unknown): boolean => (
  value === undefined
  || (Array.isArray(value)
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))
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
    , OBSERVED_HOURLY_STATS_FIELDS.every((field) => isHourlyArrayOrUndefined(state[field]))
    , isNullableStringOrUndefined(state.profileObservedStatsConfigKey)
    , isFiniteNumberArrayOrUndefined(state.plannedKWh)
    , isFiniteNumberArrayOrUndefined(state.plannedUncontrolledKWh)
    , isFiniteNumberArrayOrUndefined(state.plannedGrossUncontrolledKWh)
    , isFiniteNumberArrayOrUndefined(state.plannedControlledKWh)
    , isNullableStringOrUndefined(state.dateKey)
    , isNullableFiniteNumberOrUndefined(state.dayStartUtcMs)
    , isNullableFiniteNumberOrUndefined(state.lastPlanBucketStartUtcMs)
    , isBooleanOrUndefined(state.frozen)
    , isNumberOrUndefined(state.lastUsedNowKWh),
  ];
  return checks.every(Boolean);
};
