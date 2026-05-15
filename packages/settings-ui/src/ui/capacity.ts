import {
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsCapacityMarginAlert,
  settingsCapacityReactionHint,
  settingsPowerSourceSelect,
  settingsSimulationModeInput,
  dryRunBanner,
  type MdSwitchElement,
  type MdFilledTextFieldElement,
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
  const source = settingsPowerSourceSelect?.value;
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
  const reactionAt = Math.max(0, limit - margin).toFixed(1);
  settingsCapacityReactionHint.textContent
    = `Safe pace now ${reactionAt} kW — hard cap minus safety margin.`;
};

export const MARGIN_NOT_BELOW_LIMIT_MESSAGE
  = 'Safety margin must be less than the hard cap. Lower the margin to continue.';

// Stays silent when either number is empty or non-finite so partially-typed
// values don't flash an error mid-edit.
const getMarginVsLimitError = (limit: number, margin: number): string | null => {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(margin) || margin < 0) return null;
  if (margin >= limit) return MARGIN_NOT_BELOW_LIMIT_MESSAGE;
  return null;
};

const renderMarginAlert = (message: string | null) => {
  if (!settingsCapacityMarginAlert) return;
  settingsCapacityMarginAlert.textContent = message ?? '';
  settingsCapacityMarginAlert.hidden = message === null;
};

export const refreshLimitsValidationHints = () => {
  const limit = Number.parseFloat(settingsCapacityLimitInput?.value ?? '');
  const margin = Number.parseFloat(settingsCapacityMarginInput?.value ?? '');
  renderMarginAlert(getMarginVsLimitError(limit, margin));
};

const syncCapacityControls = (
  limit: number,
  margin: number,
  isDryRun: boolean,
  powerSource: PowerSource,
) => {
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
    settingsSimulationModeInput.selected = isDryRun;
  }
  updateCapacityReactionHint(limit, margin);
  renderMarginAlert(getMarginVsLimitError(limit, margin));
};

const readNumberInput = (input: MdFilledTextFieldElement | null, label: string): number => {
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
  if (margin >= limit) {
    renderMarginAlert(MARGIN_NOT_BELOW_LIMIT_MESSAGE);
    throw new Error(MARGIN_NOT_BELOW_LIMIT_MESSAGE);
  }
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

export const saveSettingsLimitsSettings = async () => {
  await saveCapacitySettingsPatch({
    limit: readNumberInput(settingsCapacityLimitInput, 'Hard cap'),
    margin: readNumberInput(settingsCapacityMarginInput, 'Safety margin'),
    powerSource: normalizePowerSource(settingsPowerSourceSelect?.value),
  }, 'Limits & safety saved.');
};

export const saveSimulationModeSettings = async (
  enabled = settingsSimulationModeInput ? settingsSimulationModeInput.selected : true,
) => {
  await saveCapacitySettingsPatch({
    dryRun: enabled,
  }, 'Simulation mode updated.');
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
  document.querySelectorAll<MdSwitchElement>('[data-debug-topic]').forEach((input) => {
    const el = input;
    const topic = el.dataset.debugTopic;
    el.selected = typeof topic === 'string' && isDebugLoggingTopic(topic) && enabledTopics.includes(topic);
  });
};
