import {
  capacityLimitInput,
  capacityMarginInput,
  capacityDryRunInput,
  powerSourceSelect,
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsCapacityReactionHint,
  settingsPowerSourceSelect,
  settingsSimulationModeInput,
  advancedEvSupportEnabledInput,
  advancedOverviewRedesignEnabledInput,
  dryRunBanner,
  staleDataBanner,
  staleDataBannerText,
} from './dom.ts';
import { getSetting } from './homey.ts';
import { state } from './state.ts';
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
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../../shared-domain/src/powerFreshness.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import { showToast } from './toast.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { resolveOverviewRedesignPreference } from './uiVariant.ts';

type PowerSource = 'flow' | 'homey_energy';

type CapacitySettingsPatch = {
  limit?: number;
  margin?: number;
  dryRun?: boolean;
  powerSource?: PowerSource;
};

type CurrentCapacitySettings = {
  limit: unknown;
  margin: unknown;
  dryRun: unknown;
  powerSource: unknown;
};

type ResolvedCapacitySettings = {
  limit: number;
  margin: number;
  dryRun: boolean;
  powerSource: PowerSource;
};

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

const updateCapacityReactionHint = (limit: number, margin: number) => {
  if (!settingsCapacityReactionHint) return;
  const reactionAt = Math.max(0, limit - margin);
  settingsCapacityReactionHint.textContent = `PELS reacts at ${reactionAt.toFixed(1)} kW.`;
};

const syncCapacityControls = (
  limit: number,
  margin: number,
  isDryRun: boolean,
  powerSource: PowerSource,
) => {
  capacityLimitInput.value = limit.toString();
  capacityMarginInput.value = margin.toString();
  if (capacityDryRunInput) {
    capacityDryRunInput.checked = isDryRun;
  }
  if (powerSourceSelect) {
    powerSourceSelect.value = powerSource;
  }
  if (settingsCapacityLimitInput) {
    settingsCapacityLimitInput.value = limit.toString();
  }
  if (settingsCapacityMarginInput) {
    settingsCapacityMarginInput.value = margin.toString();
  }
  if (settingsPowerSourceSelect) {
    settingsPowerSourceSelect.value = powerSource;
  }
  if (settingsSimulationModeInput) {
    settingsSimulationModeInput.checked = isDryRun;
  }
  updateCapacityReactionHint(limit, margin);
};

const readNumberInput = (input: HTMLInputElement | null, label: string): number => {
  const value = parseFloat(input?.value ?? '');
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  return value;
};

const readCurrentCapacitySettings = async (): Promise<CurrentCapacitySettings> => {
  const [limit, margin, dryRun, powerSource] = await Promise.all([
    getSetting(CAPACITY_LIMIT_KW),
    getSetting(CAPACITY_MARGIN_KW),
    getSetting(CAPACITY_DRY_RUN),
    getSetting(POWER_SOURCE),
  ]);
  return { limit, margin, dryRun, powerSource };
};

const resolveCapacitySettings = (
  current: CurrentCapacitySettings,
  patch: CapacitySettingsPatch,
): ResolvedCapacitySettings => ({
  limit: patch.limit ?? (typeof current.limit === 'number' ? current.limit : 10),
  margin: patch.margin ?? (typeof current.margin === 'number' ? current.margin : 0.2),
  dryRun: patch.dryRun ?? (typeof current.dryRun === 'boolean' ? current.dryRun : true),
  powerSource: patch.powerSource ?? normalizePowerSource(current.powerSource),
});

const validateCapacitySettings = ({ limit, margin }: ResolvedCapacitySettings) => {
  // Validate limit: must be a finite positive number within reasonable bounds.
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Hard cap must be positive.');
  if (limit > 1000) throw new Error('Hard cap cannot exceed 1000 kW.');

  // Validate margin: must be a finite non-negative number within reasonable bounds.
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Safety margin must be non-negative.');
  if (margin > limit) throw new Error('Safety margin cannot exceed the hard cap.');
};

const updateStaleDataBanner = (lastPowerUpdate: number | null) => {
  if (!staleDataBanner) return;
  const now = Date.now();
  if (lastPowerUpdate === null) {
    staleDataBanner.hidden = false;
    if (staleDataBannerText) {
      staleDataBannerText.textContent = `No power data received yet. ${getStaleDataHint()}`;
    }
    return;
  }
  const isStale = (now - lastPowerUpdate) > POWER_SAMPLE_STALE_THRESHOLD_MS;
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
  updateStaleDataBanner(resolveLastPowerUpdate(power));
};

export const updateStaleDataStatusFromPowerPayload = (power: SettingsUiPowerPayload | null) => {
  updateStaleDataBanner(power ? resolveLastPowerUpdate(power) : null);
};

export const loadCapacitySettings = async () => {
  const limit = await getSetting(CAPACITY_LIMIT_KW);
  const margin = await getSetting(CAPACITY_MARGIN_KW);
  const dryRun = await getSetting(CAPACITY_DRY_RUN);
  const powerSource = await getSetting(POWER_SOURCE);
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  const normalizedLimit = typeof limit === 'number' ? limit : fallbackLimit;
  const normalizedMargin = typeof margin === 'number' ? margin : fallbackMargin;
  const isDryRun = typeof dryRun === 'boolean' ? dryRun : true;
  const normalizedPowerSource = normalizePowerSource(powerSource);
  syncCapacityControls(normalizedLimit, normalizedMargin, isDryRun, normalizedPowerSource);
  state.dryRun = isDryRun;
  updateDryRunBanner(isDryRun);
};

const saveCapacitySettingsPatch = async (
  patch: CapacitySettingsPatch,
  successMessage = 'Capacity settings saved.',
) => {
  const current = await readCurrentCapacitySettings();
  const { limit, margin, dryRun, powerSource } = resolveCapacitySettings(current, patch);
  validateCapacitySettings({ limit, margin, dryRun, powerSource });

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, CAPACITY_LIMIT_KW, current.limit, limit);
  pushSettingWriteIfChanged(writes, CAPACITY_MARGIN_KW, current.margin, margin);
  pushSettingWriteIfChanged(writes, CAPACITY_DRY_RUN, current.dryRun, dryRun);
  pushSettingWriteIfChanged(writes, POWER_SOURCE, current.powerSource, powerSource);
  if (writes.length > 0) {
    await Promise.all(writes);
  }
  state.dryRun = dryRun;
  syncCapacityControls(limit, margin, dryRun, powerSource);
  updateDryRunBanner(dryRun);
  await showToast(successMessage, 'ok');
};

export const saveCapacitySettings = async () => {
  await saveCapacitySettingsPatch({
    limit: readNumberInput(capacityLimitInput, 'Limit'),
    margin: readNumberInput(capacityMarginInput, 'Margin'),
    dryRun: capacityDryRunInput ? capacityDryRunInput.checked : true,
    powerSource: normalizePowerSource(powerSourceSelect?.value),
  });
};

export const saveSettingsLimitsSettings = async () => {
  await saveCapacitySettingsPatch({
    limit: readNumberInput(settingsCapacityLimitInput, 'Hard cap'),
    margin: readNumberInput(settingsCapacityMarginInput, 'Safety margin'),
    powerSource: normalizePowerSource(settingsPowerSourceSelect?.value),
  }, 'Limits & safety saved.');
};

export const saveSimulationModeSettings = async (
  enabled = settingsSimulationModeInput ? settingsSimulationModeInput.checked : true,
) => {
  await saveCapacitySettingsPatch({
    dryRun: enabled,
  }, 'Simulation mode updated.');
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
  if (advancedOverviewRedesignEnabledInput) {
    advancedOverviewRedesignEnabledInput.checked = resolveOverviewRedesignPreference();
  }
};
