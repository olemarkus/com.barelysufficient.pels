import { dailyBudgetBreakdownInput } from './dom.ts';
import { getSetting } from './homey.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import { DAILY_BUDGET_BREAKDOWN_ENABLED } from '../../../contracts/src/settingsKeys.ts';
import { rerenderDailyBudget } from './dailyBudget.ts';

export const loadDailyBudgetBreakdownSetting = async () => {
  if (!dailyBudgetBreakdownInput) return;
  const breakdownRaw = await getSetting(DAILY_BUDGET_BREAKDOWN_ENABLED);
  dailyBudgetBreakdownInput.selected = breakdownRaw === true;
};

const saveDailyBudgetBreakdownSetting = async () => {
  const breakdownEnabled = dailyBudgetBreakdownInput?.selected ?? false;
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
    dailyBudgetBreakdownInput.selected = breakdownEnabled;
  }
  rerenderDailyBudget();
};

export const initDailyBudgetBreakdownHandlers = () => {
  if (!dailyBudgetBreakdownInput) return;
  const autoSaveBreakdown = async () => {
    try {
      await saveDailyBudgetBreakdownSetting();
      await showToast('Daily budget breakdown setting saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save daily budget breakdown setting', error, 'dailyBudgetTuning');
      await showToastError(error, 'Failed to save daily budget breakdown setting.');
    }
  };

  dailyBudgetBreakdownInput.addEventListener('change', autoSaveBreakdown);
};
