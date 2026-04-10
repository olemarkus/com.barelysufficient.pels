import { getPowerUsage, renderPowerStats, renderPowerUsage } from './power.ts';
import {
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_RESET_POWER_STATS_PATH,
  type SettingsUiResetPowerStatsResponse,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, primeApiCache } from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError, logSettingsInfo } from './logging.ts';
import { refreshDailyBudgetPlan } from './dailyBudget.ts';

let resetTimeout: ReturnType<typeof setTimeout> | null = null;

export const handleResetStats = async (btn: HTMLButtonElement) => {
  if (!btn.classList.contains('confirming')) {
    await logSettingsInfo('Reset stats confirmation requested', 'handleResetStats');
    const b = btn;
    b.textContent = '\u26A0\uFE0F Click again to confirm reset';
    b.classList.add('confirming');
    b.style.color = 'var(--homey-red, #f44336)';

    if (resetTimeout) clearTimeout(resetTimeout);
    resetTimeout = setTimeout(() => {
      const el = btn;
      el.textContent = 'Reset all stats';
      el.classList.remove('confirming');
      el.style.color = '';
      resetTimeout = null;
    }, 5000);
    return;
  }

  await logSettingsInfo('Reset stats confirmed', 'handleResetStats');
  if (resetTimeout) clearTimeout(resetTimeout);
  const b = btn;
  b.textContent = 'Resetting...';

  try {
    const response = await callApi<SettingsUiResetPowerStatsResponse>('POST', SETTINGS_UI_RESET_POWER_STATS_PATH, {});
    primeApiCache(SETTINGS_UI_POWER_PATH, response?.power ?? { tracker: null, status: null, heartbeat: null });

    const usage = await getPowerUsage();
    renderPowerUsage(usage);
    await renderPowerStats();
    if (response?.dailyBudget !== undefined) {
      await refreshDailyBudgetPlan(response.dailyBudget);
    }
    await showToast('Power stats reset (current hour preserved).', 'ok');
    await logSettingsInfo('Reset stats completed', 'handleResetStats');
  } catch (error) {
    await logSettingsError('Reset stats failed', error, 'handleResetStats');
    await showToastError(error, 'Failed to reset stats.');
  } finally {
    const el = btn;
    el.textContent = 'Reset all stats';
    el.classList.remove('confirming');
    el.style.color = '';
    resetTimeout = null;
  }
};
