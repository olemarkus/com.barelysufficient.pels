import {
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  dryRunBanner,
  staleDataBanner,
  debugLoggingEnabledCheckbox,
} from './dom';
import { getSetting, setSetting } from './homey';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../../settingsKeys';
import { showToast } from './toast';

const STALE_DATA_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const updateDryRunBanner = (isDryRun: boolean) => {
  if (dryRunBanner) {
    dryRunBanner.hidden = !isDryRun;
  }
};

const updateStaleDataBanner = (lastPowerUpdate: number | null) => {
  if (!staleDataBanner) return;
  if (lastPowerUpdate === null) {
    // No data ever received - show warning
    staleDataBanner.hidden = false;
    return;
  }
  const now = Date.now();
  const isStale = (now - lastPowerUpdate) > STALE_DATA_THRESHOLD_MS;
  staleDataBanner.hidden = !isStale;
};

export const loadStaleDataStatus = async () => {
  const status = await getSetting('pels_status') as { lastPowerUpdate?: number | null } | null;
  updateStaleDataBanner(status?.lastPowerUpdate ?? null);
};

export const loadCapacitySettings = async () => {
  const limit = await getSetting(CAPACITY_LIMIT_KW);
  const margin = await getSetting(CAPACITY_MARGIN_KW);
  const dryRun = await getSetting(CAPACITY_DRY_RUN);
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  capacityLimitInput.value = typeof limit === 'number' ? limit.toString() : fallbackLimit.toString();
  capacityMarginInput.value = typeof margin === 'number' ? margin.toString() : fallbackMargin.toString();
  const isDryRun = typeof dryRun === 'boolean' ? dryRun : true;
  if (capacityDryRunInput) {
    capacityDryRunInput.checked = isDryRun;
  }
  updateDryRunBanner(isDryRun);
};

export const saveCapacitySettings = async () => {
  const limit = parseFloat(capacityLimitInput.value);
  const margin = parseFloat(capacityMarginInput.value);
  const dryRun = capacityDryRunInput ? capacityDryRunInput.checked : true;

  // Validate limit: must be a finite positive number within reasonable bounds
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Limit must be positive.');
  if (limit > 1000) throw new Error('Limit cannot exceed 1000 kW.');

  // Validate margin: must be a finite non-negative number within reasonable bounds
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Margin must be non-negative.');
  if (margin > limit) throw new Error('Margin cannot exceed the limit.');

  await setSetting(CAPACITY_LIMIT_KW, limit);
  await setSetting(CAPACITY_MARGIN_KW, margin);
  await setSetting(CAPACITY_DRY_RUN, dryRun);
  updateDryRunBanner(dryRun);
  await showToast('Capacity settings saved.', 'ok');
};

export const loadAdvancedSettings = async () => {
  const debugEnabled = await getSetting('debug_logging_enabled');
  if (debugLoggingEnabledCheckbox) {
    debugLoggingEnabledCheckbox.checked = debugEnabled === true;
  }
};
