import {
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  powerSourceSelect,
  advancedEvSupportEnabledInput,
  dryRunBanner,
  staleDataBanner,
  staleDataBannerText,
} from './dom.ts';
import { getSetting } from './homey.ts';
import { getPowerReadModel } from './power.ts';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEBUG_LOGGING_TOPICS,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  POWER_SOURCE,
} from '../../../contracts/src/settingsKeys.ts';
import {
  ALL_DEBUG_LOGGING_TOPICS,
  normalizeDebugLoggingTopics,
  type DebugLoggingTopic,
} from '../../../shared-domain/src/utils/debugLogging.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import { showToast } from './toast.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';

const STALE_DATA_THRESHOLD_MS = 60 * 1000;
const HEARTBEAT_THRESHOLD_MS = 90 * 1000;

type PowerSource = 'flow' | 'homey_energy';

const normalizePowerSource = (raw: unknown): PowerSource => (
  raw === 'homey_energy' ? 'homey_energy' : 'flow'
);

const getStaleDataHint = (): string => {
  const source = powerSourceSelect?.value;
  if (source === 'homey_energy') {
    return 'Check that a device with "Tracks total home energy consumption" is enabled in Homey Energy.';
  }
  return 'Check your Flow that reports power usage.';
};

const isDebugLoggingTopic = (value: string): value is DebugLoggingTopic => (
  ALL_DEBUG_LOGGING_TOPICS.includes(value as DebugLoggingTopic)
);

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
    staleDataBanner.hidden = false;
    if (staleDataBannerText) {
      staleDataBannerText.textContent = `No power data received yet. ${getStaleDataHint()}`;
    }
    return;
  }
  const isStale = (now - lastPowerUpdate) > STALE_DATA_THRESHOLD_MS;
  staleDataBanner.hidden = !isStale;
  if (staleDataBannerText && isStale) {
    staleDataBannerText.textContent = `No power data received in the last minute. ${getStaleDataHint()}`;
  }
};

const resolveLastPowerUpdate = (power: SettingsUiPowerPayload): number | null => {
  const trackerTimestamp = power.tracker?.lastTimestamp;
  if (typeof trackerTimestamp === 'number' && Number.isFinite(trackerTimestamp)) {
    return trackerTimestamp;
  }
  const statusTimestamp = power.status?.lastPowerUpdate;
  return typeof statusTimestamp === 'number' && Number.isFinite(statusTimestamp) ? statusTimestamp : null;
};

export const loadStaleDataStatus = async () => {
  const power = await getPowerReadModel();
  updateStaleDataBanner(resolveLastPowerUpdate(power), power.heartbeat);
};

export const loadCapacitySettings = async () => {
  const limit = await getSetting(CAPACITY_LIMIT_KW);
  const margin = await getSetting(CAPACITY_MARGIN_KW);
  const dryRun = await getSetting(CAPACITY_DRY_RUN);
  const powerSource = await getSetting(POWER_SOURCE);
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  capacityLimitInput.value = typeof limit === 'number' ? limit.toString() : fallbackLimit.toString();
  capacityMarginInput.value = typeof margin === 'number' ? margin.toString() : fallbackMargin.toString();
  const isDryRun = typeof dryRun === 'boolean' ? dryRun : true;
  if (capacityDryRunInput) {
    capacityDryRunInput.checked = isDryRun;
  }
  if (powerSourceSelect) {
    powerSourceSelect.value = normalizePowerSource(powerSource);
  }
  updateDryRunBanner(isDryRun);
};

export const saveCapacitySettings = async () => {
  const limit = parseFloat(capacityLimitInput.value);
  const margin = parseFloat(capacityMarginInput.value);
  const dryRun = capacityDryRunInput ? capacityDryRunInput.checked : true;
  const powerSource = normalizePowerSource(powerSourceSelect?.value);

  // Validate limit: must be a finite positive number within reasonable bounds
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Limit must be positive.');
  if (limit > 1000) throw new Error('Limit cannot exceed 1000 kW.');

  // Validate margin: must be a finite non-negative number within reasonable bounds
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Margin must be non-negative.');
  if (margin > limit) throw new Error('Margin cannot exceed the limit.');

  const [currentLimit, currentMargin, currentDryRun, currentPowerSource] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
    getSetting(POWER_SOURCE),
  ]);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, CAPACITY_LIMIT_KW, currentLimit, limit);
  pushSettingWriteIfChanged(writes, CAPACITY_MARGIN_KW, currentMargin, margin);
  pushSettingWriteIfChanged(writes, CAPACITY_DRY_RUN, currentDryRun, dryRun);
  pushSettingWriteIfChanged(writes, POWER_SOURCE, currentPowerSource, powerSource);
  if (writes.length > 0) {
    await Promise.all(writes);
  }
  updateDryRunBanner(dryRun);
  await showToast('Capacity settings saved.', 'ok');
};

export const loadAdvancedSettings = async () => {
  const [topicsRaw, legacyEnabled, evSupportEnabled] = await Promise.all([
    getSetting(DEBUG_LOGGING_TOPICS),
    getSetting('debug_logging_enabled'),
    getSetting(EXPERIMENTAL_EV_SUPPORT_ENABLED),
  ]);
  let enabledTopics = normalizeDebugLoggingTopics(topicsRaw);
  if (enabledTopics.length === 0 && legacyEnabled === true) {
    enabledTopics = [...ALL_DEBUG_LOGGING_TOPICS];
  }
  document.querySelectorAll<HTMLInputElement>('[data-debug-topic]').forEach((input) => {
    const el = input;
    const topic = el.dataset.debugTopic;
    el.checked = typeof topic === 'string' && isDebugLoggingTopic(topic) && enabledTopics.includes(topic);
  });
  if (advancedEvSupportEnabledInput) {
    advancedEvSupportEnabledInput.checked = evSupportEnabled === true;
  }
};
