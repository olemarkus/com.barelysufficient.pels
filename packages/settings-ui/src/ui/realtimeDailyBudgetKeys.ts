// Realtime settings-key routing sets for the daily-budget surfaces. Split
// out of `realtime.ts` so that module stays under the max-lines cap without
// trimming load-bearing comments.
import {
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  PRICE_OPTIMIZATION_ENABLED,
} from '../../../contracts/src/settingsKeys.ts';

// Keys whose change refreshes the daily-budget PLAN payload (the chart/hero
// data), including inputs the allocator derives from (prices, capacity).
export const DAILY_BUDGET_REFRESH_KEYS = new Set([
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
  'daily_budget_reset',
  COMBINED_PRICES,
  PRICE_OPTIMIZATION_ENABLED,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
]);

// Keys that additionally refresh the Adjust draft (user-editable settings).
export const DAILY_BUDGET_SETTINGS_KEYS = new Set([
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
]);
