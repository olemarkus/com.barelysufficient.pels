import {
  dailyBudgetAdvancedForm,
  dailyBudgetControlledWeightInput,
  dailyBudgetPriceFlexShareInput,
  dailyBudgetBreakdownInput,
} from './dom.ts';
import { getSetting } from './homey.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import {
  CONTROLLED_USAGE_WEIGHT,
  PRICE_SHAPING_FLEX_SHARE,
} from '../../../contracts/src/dailyBudgetConstants.ts';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
} from '../../../contracts/src/settingsKeys.ts';
import { markDailyBudgetModelDraftChanged, rerenderDailyBudget } from './dailyBudget.ts';

const clampRatio = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
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

const saveDailyBudgetBreakdownSetting = async () => {
  const breakdownEnabled = dailyBudgetBreakdownInput?.checked ?? false;
  const currentBreakdown = await getSetting(DAILY_BUDGET_BREAKDOWN_ENABLED);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_BREAKDOWN_ENABLED,
    currentBreakdown,
    breakdownEnabled,
  );
  if (writes.length > 0) {
    await Promise.all(writes);
  }

  if (dailyBudgetBreakdownInput) {
    dailyBudgetBreakdownInput.checked = breakdownEnabled;
  }
  rerenderDailyBudget();
};

export const initDailyBudgetTuningHandlers = () => {
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput && !dailyBudgetBreakdownInput) return;
  const autoSaveBreakdown = async () => {
    try {
      await saveDailyBudgetBreakdownSetting();
      await showToast('Daily budget breakdown setting saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save daily budget breakdown setting', error, 'dailyBudgetTuning');
      await showToastError(error, 'Failed to save daily budget breakdown setting.');
    }
  };

  dailyBudgetControlledWeightInput?.addEventListener('change', markDailyBudgetModelDraftChanged);
  dailyBudgetPriceFlexShareInput?.addEventListener('change', markDailyBudgetModelDraftChanged);
  dailyBudgetBreakdownInput?.addEventListener('change', autoSaveBreakdown);
  dailyBudgetAdvancedForm?.addEventListener('submit', (event) => event.preventDefault());
};
