import {
  dailyBudgetAdvancedForm,
  dailyBudgetControlledWeightInput,
  dailyBudgetPriceFlexShareInput,
} from './dom';
import { getSetting, setSetting } from './homey';
import { logSettingsError } from './logging';
import { showToast, showToastError } from './toast';
import {
  CONTROLLED_USAGE_WEIGHT,
  PRICE_SHAPING_FLEX_SHARE,
} from '../../../lib/dailyBudget/dailyBudgetConstants';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
} from '../../../lib/utils/settingsKeys';

const clampRatio = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

const parseRatioInput = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return clampRatio(parsed, fallback);
};

const setInputValue = (input: HTMLInputElement | null, value: number) => {
  if (!input) return;
  const target = input;
  target.value = value.toString();
};

export const loadDailyBudgetTuningSettings = async () => {
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput) return;
  const [controlledWeightRaw, priceFlexShareRaw] = await Promise.all([
    getSetting(DAILY_BUDGET_CONTROLLED_WEIGHT),
    getSetting(DAILY_BUDGET_PRICE_FLEX_SHARE),
  ]);
  const controlledWeight = clampRatio(
    typeof controlledWeightRaw === 'number' ? controlledWeightRaw : Number.NaN,
    CONTROLLED_USAGE_WEIGHT,
  );
  const priceFlexShare = clampRatio(
    typeof priceFlexShareRaw === 'number' ? priceFlexShareRaw : Number.NaN,
    PRICE_SHAPING_FLEX_SHARE,
  );
  setInputValue(dailyBudgetControlledWeightInput, controlledWeight);
  setInputValue(dailyBudgetPriceFlexShareInput, priceFlexShare);
};

const saveDailyBudgetTuningSettings = async () => {
  const controlledWeight = parseRatioInput(
    dailyBudgetControlledWeightInput?.value ?? '',
    CONTROLLED_USAGE_WEIGHT,
  );
  const priceFlexShare = parseRatioInput(
    dailyBudgetPriceFlexShareInput?.value ?? '',
    PRICE_SHAPING_FLEX_SHARE,
  );

  await Promise.all([
    setSetting(DAILY_BUDGET_CONTROLLED_WEIGHT, controlledWeight),
    setSetting(DAILY_BUDGET_PRICE_FLEX_SHARE, priceFlexShare),
  ]);

  setInputValue(dailyBudgetControlledWeightInput, controlledWeight);
  setInputValue(dailyBudgetPriceFlexShareInput, priceFlexShare);
};

export const initDailyBudgetTuningHandlers = () => {
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput) return;
  const autoSave = async () => {
    try {
      await saveDailyBudgetTuningSettings();
      await showToast('Daily budget tuning saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save daily budget tuning', error, 'dailyBudgetTuning');
      await showToastError(error, 'Failed to save daily budget tuning.');
    }
  };

  dailyBudgetControlledWeightInput?.addEventListener('change', autoSave);
  dailyBudgetPriceFlexShareInput?.addEventListener('change', autoSave);
  dailyBudgetAdvancedForm?.addEventListener('submit', (event) => event.preventDefault());
};
