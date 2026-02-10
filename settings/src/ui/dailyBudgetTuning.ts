import {
  dailyBudgetAdvancedForm,
  dailyBudgetControlledWeightInput,
  dailyBudgetPriceFlexShareInput,
  dailyBudgetBreakdownInput,
} from './dom';
import { getSetting } from './homey';
import { pushSettingWriteIfChanged } from './settingWrites';
import { logSettingsError } from './logging';
import { showToast, showToastError } from './toast';
import {
  CONTROLLED_USAGE_WEIGHT,
  PRICE_SHAPING_FLEX_SHARE,
} from '../../../lib/dailyBudget/dailyBudgetConstants';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
} from '../../../lib/utils/settingsKeys';
import { rerenderDailyBudget } from './dailyBudget';

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
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput && !dailyBudgetBreakdownInput) return;
  const [controlledWeightRaw, priceFlexShareRaw, breakdownRaw] = await Promise.all([
    getSetting(DAILY_BUDGET_CONTROLLED_WEIGHT),
    getSetting(DAILY_BUDGET_PRICE_FLEX_SHARE),
    getSetting(DAILY_BUDGET_BREAKDOWN_ENABLED),
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
  if (dailyBudgetBreakdownInput) {
    dailyBudgetBreakdownInput.checked = breakdownRaw === true;
  }
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
  const breakdownEnabled = dailyBudgetBreakdownInput?.checked ?? false;

  const [currentControlledWeight, currentPriceFlexShare, currentBreakdown] = await Promise.all([
    getSetting(DAILY_BUDGET_CONTROLLED_WEIGHT),
    getSetting(DAILY_BUDGET_PRICE_FLEX_SHARE),
    getSetting(DAILY_BUDGET_BREAKDOWN_ENABLED),
  ]);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_CONTROLLED_WEIGHT,
    currentControlledWeight,
    controlledWeight,
  );
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_PRICE_FLEX_SHARE,
    currentPriceFlexShare,
    priceFlexShare,
  );
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_BREAKDOWN_ENABLED,
    currentBreakdown,
    breakdownEnabled,
  );
  if (writes.length > 0) {
    await Promise.all(writes);
  }

  setInputValue(dailyBudgetControlledWeightInput, controlledWeight);
  setInputValue(dailyBudgetPriceFlexShareInput, priceFlexShare);
  if (dailyBudgetBreakdownInput) {
    dailyBudgetBreakdownInput.checked = breakdownEnabled;
  }
  rerenderDailyBudget();
};

export const initDailyBudgetTuningHandlers = () => {
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput && !dailyBudgetBreakdownInput) return;
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
  dailyBudgetBreakdownInput?.addEventListener('change', autoSave);
  dailyBudgetAdvancedForm?.addEventListener('submit', (event) => event.preventDefault());
};
