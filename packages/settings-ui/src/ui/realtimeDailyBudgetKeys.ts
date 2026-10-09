// Realtime settings-key routing sets for the daily-budget surfaces. Split
// out of `realtime.ts` so that module stays under the max-lines cap without
// trimming load-bearing comments.
import {
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  PRICE_OPTIMIZATION_ENABLED,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
} from '../../../shared-domain/src/settings/settingsKeys.ts';

// Keys whose change refreshes the daily-budget PLAN payload (the chart/hero
// data), including inputs the allocator derives from (prices, capacity).
export const DAILY_BUDGET_REFRESH_KEYS = new Set([
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
  PRICE_OPTIMIZATION_ENABLED,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
]);

// Keys that additionally refresh the Adjust draft (user-editable settings).
export const DAILY_BUDGET_SETTINGS_KEYS = new Set([
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
]);
