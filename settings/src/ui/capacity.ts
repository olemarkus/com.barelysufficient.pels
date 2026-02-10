import {
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  dryRunBanner,
  staleDataBanner,
  staleDataBannerText,
  debugLoggingTopicInputs,
} from './dom';
import { getSetting } from './homey';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, DEBUG_LOGGING_TOPICS } from '../../../lib/utils/settingsKeys';
import { ALL_DEBUG_LOGGING_TOPICS, normalizeDebugLoggingTopics } from '../../../lib/utils/debugLogging';
import { showToast } from './toast';
import { pushSettingWriteIfChanged } from './settingWrites';

const STALE_DATA_THRESHOLD_MS = 60 * 1000;
const HEARTBEAT_THRESHOLD_MS = 90 * 1000;

const updateDryRunBanner = (isDryRun: boolean) => {
  if (dryRunBanner) {
    dryRunBanner.hidden = !isDryRun;
  }
};

const updateStaleDataBanner = (lastPowerUpdate: number | null, lastHeartbeat: number | null) => {
  if (!staleDataBanner) return;
  const now = Date.now();
  if (typeof lastHeartbeat === 'number' && (now - lastHeartbeat) > HEARTBEAT_THRESHOLD_MS) {
    staleDataBanner.hidden = false;
    if (staleDataBannerText) {
      staleDataBannerText.textContent = 'App heartbeat missing. PELS may not be running.';
    }
    return;
  }
  if (lastPowerUpdate === null) {
    // No data ever received - show warning
    staleDataBanner.hidden = false;
    if (staleDataBannerText) {
      staleDataBannerText.textContent = 'No power data received yet. Check your Flow that reports power usage.';
    }
    return;
  }
  const isStale = (now - lastPowerUpdate) > STALE_DATA_THRESHOLD_MS;
  staleDataBanner.hidden = !isStale;
  if (staleDataBannerText && isStale) {
    staleDataBannerText.textContent = 'No power data received in the last minute. Check your Flow that reports power usage.';
  }
};

export const loadStaleDataStatus = async () => {
  const [status, heartbeat] = await Promise.all([
    getSetting('pels_status'),
    getSetting('app_heartbeat'),
  ]);
  const typedStatus = status as { lastPowerUpdate?: number | null } | null;
  updateStaleDataBanner(typedStatus?.lastPowerUpdate ?? null, typeof heartbeat === 'number' ? heartbeat : null);
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

  const [currentLimit, currentMargin, currentDryRun] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
  ]);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, CAPACITY_LIMIT_KW, currentLimit, limit);
  pushSettingWriteIfChanged(writes, CAPACITY_MARGIN_KW, currentMargin, margin);
  pushSettingWriteIfChanged(writes, CAPACITY_DRY_RUN, currentDryRun, dryRun);
  if (writes.length > 0) {
    await Promise.all(writes);
  }
  updateDryRunBanner(dryRun);
  await showToast('Capacity settings saved.', 'ok');
};

export const loadAdvancedSettings = async () => {
  const [topicsRaw, legacyEnabled] = await Promise.all([
    getSetting(DEBUG_LOGGING_TOPICS),
    getSetting('debug_logging_enabled'),
  ]);
  let enabledTopics = normalizeDebugLoggingTopics(topicsRaw);
  if (enabledTopics.length === 0 && legacyEnabled === true) {
    enabledTopics = [...ALL_DEBUG_LOGGING_TOPICS];
  }
  debugLoggingTopicInputs.forEach((input) => {
    const el = input;
    const topic = el.dataset.debugTopic;
    el.checked = typeof topic === 'string' && enabledTopics.includes(topic);
  });
};
