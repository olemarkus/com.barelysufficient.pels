import type Homey from 'homey';
import type { DailyBudgetSettingsStore } from '../lib/dailyBudget/dailyBudgetSettingsStore';
import type { DailyBudgetSettings } from '../lib/dailyBudget/dailyBudgetTypes';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../lib/utils/settingsKeys';
import {
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_FLEX_HIGH,
  PRICE_FLEX_HIGH_THRESHOLD,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
} from '../lib/dailyBudget/dailyBudgetConstants';

const normalizeUnmanagedReserveMode = (value: unknown): number => {
  if (!isFiniteNumber(value)) return UNMANAGED_RESERVE_MODE;
  return value >= 0.5 ? UNMANAGED_RESERVE_CONSERVATIVE_MODE : UNMANAGED_RESERVE_MODE;
};

const normalizePriceFlexShare = (value: unknown): number => {
  if (!isFiniteNumber(value)) return PRICE_SHAPING_FLEX_SHARE;
  const bounded = Math.min(1, Math.max(0, value));
  if (bounded <= PRICE_FLEX_LOW) return PRICE_FLEX_LOW;
  if (bounded > PRICE_FLEX_HIGH_THRESHOLD) return PRICE_FLEX_HIGH;
  return PRICE_FLEX_MEDIUM;
};

/**
 * Builds the {@link DailyBudgetSettingsStore}: the sole owner of the
 * `homey.settings` read/write for the daily-budget configuration keys plus the
 * normalisation that snaps persisted garbage/out-of-range scalars to canonical
 * values. The service receives only a typed `DailyBudgetSettings`.
 */
export const createDailyBudgetSettingsStore = (
  homey: Homey.App['homey'],
): DailyBudgetSettingsStore => ({
  read(): DailyBudgetSettings {
    const enabled = homey.settings.get(DAILY_BUDGET_ENABLED) as unknown;
    const budgetKWh = homey.settings.get(DAILY_BUDGET_KWH) as unknown;
    const priceShapingEnabled = homey.settings.get(DAILY_BUDGET_PRICE_SHAPING_ENABLED) as unknown;
    const controlledWeight = homey.settings.get(DAILY_BUDGET_CONTROLLED_WEIGHT) as unknown;
    const priceFlexShare = homey.settings.get(DAILY_BUDGET_PRICE_FLEX_SHARE) as unknown;
    const rawBudget = isFiniteNumber(budgetKWh) ? Math.max(0, budgetKWh) : 0;
    const boundedBudget = rawBudget === 0
      ? 0
      : Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, rawBudget));
    return {
      enabled: enabled === true,
      dailyBudgetKWh: boundedBudget,
      priceShapingEnabled: priceShapingEnabled !== false,
      controlledUsageWeight: normalizeUnmanagedReserveMode(controlledWeight),
      priceShapingFlexShare: normalizePriceFlexShare(priceFlexShare),
    };
  },
  write(settings: DailyBudgetSettings): void {
    homey.settings.set(DAILY_BUDGET_ENABLED, settings.enabled);
    homey.settings.set(DAILY_BUDGET_KWH, settings.dailyBudgetKWh);
    homey.settings.set(DAILY_BUDGET_PRICE_SHAPING_ENABLED, settings.priceShapingEnabled);
    homey.settings.set(DAILY_BUDGET_CONTROLLED_WEIGHT, settings.controlledUsageWeight);
    homey.settings.set(DAILY_BUDGET_PRICE_FLEX_SHARE, settings.priceShapingFlexShare);
  },
});
