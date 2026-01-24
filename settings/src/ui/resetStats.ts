import type { PowerTracker } from './power';
import { renderPowerStats, renderPowerUsage } from './power';
import { getSetting, setSetting } from './homey';
import { showToast, showToastError } from './toast';
import { logSettingsError, logSettingsInfo } from './logging';
import { getHourBucketKey } from '../../../lib/utils/dateUtils';

let resetTimeout: ReturnType<typeof setTimeout> | null = null;

const calculateResetState = (currentState: PowerTracker): PowerTracker => {
  const currentHourKey = getHourBucketKey();

  const newBuckets: Record<string, number> = {};
  if (currentState.buckets && currentState.buckets[currentHourKey] !== undefined) {
    newBuckets[currentHourKey] = currentState.buckets[currentHourKey];
  }

  const newBudgets: Record<string, number> = {};
  if (currentState.hourlyBudgets && currentState.hourlyBudgets[currentHourKey] !== undefined) {
    newBudgets[currentHourKey] = currentState.hourlyBudgets[currentHourKey];
  }

  return {
    ...currentState,
    buckets: newBuckets,
    hourlyBudgets: newBudgets,
    dailyTotals: {},
    hourlyAverages: {},
    unreliablePeriods: [],
  };
};

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
    const currentState = (await getSetting('power_tracker_state') as PowerTracker) || {};
    const newState = calculateResetState(currentState);

    await setSetting('power_tracker_state', newState);

    renderPowerUsage(Object.entries(newState.buckets || {}).map(([hour, kWh]) => ({
      hour: new Date(hour),
      kWh,
      budgetKWh: (newState.hourlyBudgets || {})[hour],
    })));
    await renderPowerStats();
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
