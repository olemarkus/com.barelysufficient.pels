import type { DailyBudgetModelSettings } from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_MODE,
} from '../../../contracts/src/dailyBudgetConstants.ts';
import {
  dailyBudgetControlledWeightInput,
  dailyBudgetEnabledInput,
  dailyBudgetKwhInput,
  dailyBudgetPriceFlexShareInput,
  dailyBudgetPriceShapingInput,
} from './dom.ts';
import { priceFlexModeValue, reserveModeValue } from './dailyBudgetTuningValues.ts';

const clampRatio = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

export const parseDailyBudgetRatio = (value: string, fallback: number): number => (
  clampRatio(Number.parseFloat(value), fallback)
);

export const applyDailyBudgetBounds = (): void => {
  if (!dailyBudgetKwhInput) return;
  dailyBudgetKwhInput.min = MIN_DAILY_BUDGET_KWH.toString();
  dailyBudgetKwhInput.max = MAX_DAILY_BUDGET_KWH.toString();
};

export const applyDailyBudgetSettingsToLegacyForm = (settings: DailyBudgetModelSettings): void => {
  applyDailyBudgetBounds();
  if (dailyBudgetEnabledInput) dailyBudgetEnabledInput.checked = Boolean(settings.enabled);
  if (dailyBudgetKwhInput) {
    const bounded = Math.min(
      MAX_DAILY_BUDGET_KWH,
      Math.max(MIN_DAILY_BUDGET_KWH, Number(settings.dailyBudgetKWh)),
    );
    dailyBudgetKwhInput.value = bounded.toString();
  }
  if (dailyBudgetPriceShapingInput) {
    dailyBudgetPriceShapingInput.checked = Boolean(settings.priceShapingEnabled);
  }
  if (dailyBudgetControlledWeightInput) {
    const mode = parseDailyBudgetRatio(String(settings.controlledUsageWeight), UNMANAGED_RESERVE_MODE);
    dailyBudgetControlledWeightInput.value = reserveModeValue(mode);
  }
  if (dailyBudgetPriceFlexShareInput) {
    const mode = parseDailyBudgetRatio(String(settings.priceShapingFlexShare), PRICE_SHAPING_FLEX_SHARE);
    dailyBudgetPriceFlexShareInput.value = priceFlexModeValue(mode);
  }
};
