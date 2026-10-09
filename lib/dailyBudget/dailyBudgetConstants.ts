// Daily-budget tuning constants. The setting bounds and option values the
// settings UI also uses have their one copy in
// `packages/shared-domain/src/settings/dailyBudgetSettings.ts` and are
// re-exported here for lib/dailyBudget and its wiring. A peer the dependency
// rules bar from lib/dailyBudget (lib/weather) imports the shared module itself.
export {
  MIN_DAILY_BUDGET_KWH,
  MAX_DAILY_BUDGET_KWH,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
  PRICE_SHAPING_FLEX_SHARE,
} from '../../packages/shared-domain/src/settings/dailyBudgetSettings';

export const CONTROLLED_USAGE_WEIGHT = 0.3;
export const PRICE_SHAPING_PRICE_RANGE_EPSILON = 1e-6;
export const OBSERVED_HOURLY_PEAK_MARGIN_RATIO = 0.2;
export const OBSERVED_HOURLY_PEAK_WINDOW_DAYS = 30;
export const OBSERVED_HOURLY_MAX_QUANTILE = 0.9;
export const OBSERVED_HOURLY_MIN_QUANTILE = 0.25;
export const OBSERVED_HOURLY_QUANTILE_MIN_SAMPLES = 5;
export const UNCONTROLLED_RESERVE_BASE_QUANTILE = 0.5;
export const UNCONTROLLED_RESERVE_MAX_QUANTILE = 0.75;
export const UNCONTROLLED_RESERVE_TAIL_RATIO_FOR_MAX = 1.5;
export const UNCONTROLLED_RESERVE_DENOMINATOR_FLOOR_KWH = 0.25;
export const UNCONTROLLED_RESERVE_MIN_KWH = 0.05;
export const PLAN_REBUILD_INTERVAL_MS = 60 * 60 * 1000;
export const PLAN_REBUILD_USAGE_DELTA_KWH = 0.05;
export const PLAN_REBUILD_USAGE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const PREVIOUS_PLAN_BLEND_WEIGHT = 0.7;
export const NEW_PLAN_BLEND_WEIGHT = 1 - PREVIOUS_PLAN_BLEND_WEIGHT;
