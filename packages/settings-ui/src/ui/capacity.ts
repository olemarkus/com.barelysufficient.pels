import { syncSettingsHubChips } from './settingsHubChips.ts';
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
  staleDataBannerAction,
} from './dom.ts';
import { getSetting } from './homey.ts';
import { state } from './state.ts';
import { getPowerReadModel } from './power.ts';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEBUG_LOGGING_TOPICS,
  HOMEY_ENERGY_METER_DEVICE_ID,
  POWER_SOURCE,
} from '../../../contracts/src/settingsKeys.ts';
import {
  isHomeyEnergyMeterExplicit,
  syncHomeyEnergyMeterField,
  syncHomeyEnergyMeterVisibility,
} from './homeyEnergyMeter.ts';
import {
  ALL_DEBUG_LOGGING_TOPICS,
  type DebugLoggingScenarioId,
  isDebugLoggingScenarioId,
  normalizeDebugLoggingTopics,
  topicsToScenarioIds,
} from '../../../shared-domain/src/utils/debugLogging.ts';
import { renderLegacyTopicsHint } from './debugLoggingHint.ts';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../../shared-domain/src/powerFreshness.ts';
import type { SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import { showToast } from './toast.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';

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

// Exported pure for tests; the meterSelected branch points at the explicitly
// selected meter instead of Homey Energy's whole-home marking.
export const resolveStaleDataHint = (source: string | undefined, meterSelected: boolean): string => {
  if (source === 'homey_energy') {
    return meterSelected
      ? 'Check that the selected whole-home meter is available and reporting power in Homey Energy.'
      : 'Check that a device with "Tracks total home energy consumption" is enabled in Homey Energy.';
  }
  return 'Check your Flow that reports power usage.';
};

const getStaleDataHint = (): string => (
  resolveStaleDataHint(settingsPowerSourceSelect?.value, isHomeyEnergyMeterExplicit())
);

export type StaleDataBannerContent = { text: string; actionLabel: string };

// Exported pure for tests. The runtime never writes a default `power_source`,
// so an absent setting plus no sample ever received means a fresh install where
// the user hasn't chosen where PELS reads power from — that state gets
// onboarding copy instead of a "check your Flow" hint about a Flow that was
// never set up. Returns null when the banner should hide (fresh data).
export const resolveStaleDataBannerContent = (input: {
  lastPowerUpdate: number | null;
  nowMs: number;
  powerSourceConfigured: boolean;
  hint: string;
}): StaleDataBannerContent | null => {
  if (input.lastPowerUpdate === null) {
    if (!input.powerSourceConfigured) {
      return {
        text: 'No power data yet. PELS needs to know where to read your home’s power usage.',
        actionLabel: 'Choose power source',
      };
    }
    return {
      text: `No power data received yet. ${input.hint}`,
      actionLabel: 'Check power source',
    };
  }
  if ((input.nowMs - input.lastPowerUpdate) <= POWER_SAMPLE_STALE_THRESHOLD_MS) return null;
  return {
    text: `No power data received in the last minute. ${input.hint}`,
    actionLabel: 'Check power source',
  };
};

// The global simulation banner shows on every tab EXCEPT the Simulation-mode
// settings page, whose own toggle is the single control there (a duplicate
// control on one screen reads as confusing chrome). Reads live `state.dryRun`
// + `state.activePanel`, so both the dry-run toggle and tab navigation call it.
export const syncDryRunBannerVisibility = (): void => {
  if (dryRunBanner) {
    dryRunBanner.hidden = !state.dryRun || state.activePanel === 'simulation';
  }
};

const updateCapacityReactionHint = (limit: number, margin: number) => {
  if (!settingsCapacityReactionHint) return;
  // The result row's static label ("With these settings, safe pace starts each hour at")
  // frames this as a ceiling derived from the current inputs, not an absolute
  // "safe pace now" — that live value is the Overview hero's job and can differ
  // when today's daily budget is the tighter constraint. This element carries
  // only the loud accent value so the two surfaces never contradict.
  const reactionAt = Math.max(0, limit - margin).toFixed(1);
  settingsCapacityReactionHint.textContent = `${reactionAt} kW`;
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
  syncHomeyEnergyMeterVisibility(powerSource);
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

// null = not yet loaded. Treated as configured so a returning user with stale
// data never flashes the fresh-install copy while settings are still loading.
let powerSourceConfigured: boolean | null = null;
// Last value handed to the banner, so a settings load that resolves AFTER the
// first power read can re-render the copy without refetching power. undefined
// = the banner has never rendered.
let lastBannerPowerUpdate: number | null | undefined;

const updateStaleDataBanner = (lastPowerUpdate: number | null) => {
  lastBannerPowerUpdate = lastPowerUpdate;
  if (!staleDataBanner) return;
  const content = resolveStaleDataBannerContent({
    lastPowerUpdate,
    nowMs: Date.now(),
    powerSourceConfigured: powerSourceConfigured !== false,
    hint: getStaleDataHint(),
  });
  staleDataBanner.hidden = content === null;
  if (content === null) return;
  if (staleDataBannerText) staleDataBannerText.textContent = content.text;
  if (staleDataBannerAction) staleDataBannerAction.textContent = content.actionLabel;
};

const setPowerSourceConfigured = (configured: boolean) => {
  if (powerSourceConfigured === configured) return;
  powerSourceConfigured = configured;
  if (lastBannerPowerUpdate !== undefined) updateStaleDataBanner(lastBannerPowerUpdate);
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
  const meterDeviceId = await getSetting(HOMEY_ENERGY_METER_DEVICE_ID);
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  const normalizedLimit = typeof limit === 'number' ? limit : fallbackLimit;
  const normalizedMargin = typeof margin === 'number' ? margin : fallbackMargin;
  const isDryRun = typeof dryRun === 'boolean' ? dryRun : true;
  const normalizedPowerSource = normalizePowerSource(powerSource);
  setPowerSourceConfigured(powerSource === 'flow' || powerSource === 'homey_energy');
  // Adopt the persisted meter selection BEFORE syncCapacityControls runs its
  // visibility-only sync, so the select renders the saved choice. Trimmed the
  // same way as the runtime seam (resolveHomeyEnergyMeterDeviceId) so the UI
  // and the poll never disagree about a padded id meaning Automatic.
  const trimmedMeterId = typeof meterDeviceId === 'string' ? meterDeviceId.trim() : '';
  syncHomeyEnergyMeterField(normalizedPowerSource, trimmedMeterId === '' ? null : trimmedMeterId);
  syncCapacityControls(normalizedLimit, normalizedMargin, isDryRun, normalizedPowerSource);
  const dryRunChanged = state.dryRun !== isDryRun;
  state.dryRun = isDryRun;
  syncDryRunBannerVisibility();
  syncSettingsHubChips();
  // An external simulation-mode change (e.g. a second open WebView, or a Flow)
  // reaches here via the realtime settings.set handler. Re-render the overview
  // so the hero decision sentence and device-card "(simulation)" framing flip
  // with the banner, not on the next plan/power push. (Safe no-op before the
  // plan surface renderer is registered — e.g. the first boot load.)
  if (dryRunChanged) refreshPlanSurface();
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
  // Persist power_source ONLY when the patch explicitly carries it (the user
  // changed the select). An unrelated hard-cap/margin/simulation save must not
  // materialize the 'flow' default — that would silently flip the banner's
  // fresh-install copy to "check your Flow" for a user who never chose a source.
  if (patch.powerSource !== undefined) {
    pushSettingWriteIfChanged(writes, POWER_SOURCE, current.powerSource, powerSource);
  }
  if (writes.length > 0) {
    await Promise.all(writes);
  }
  const dryRunChanged = current.dryRun !== dryRun;
  state.dryRun = dryRun;
  if (patch.powerSource !== undefined) setPowerSourceConfigured(true);
  syncCapacityControls(limit, margin, dryRun, powerSource);
  syncDryRunBannerVisibility();
  syncSettingsHubChips();
  // Toggling simulation flips the hero decision sentence and the device-card
  // "(simulation)" hypothetical framing. Re-render the overview now so they flip
  // together with the banner instead of staying stale until the next realtime
  // push (~10s on homey_energy, longer on flow).
  if (dryRunChanged) refreshPlanSurface();
  await showToast(successMessage, 'ok');
};

export const saveSettingsLimitsSettings = async (
  options?: { includePowerSource?: boolean },
) => {
  await saveCapacitySettingsPatch({
    limit: readNumberInput(settingsCapacityLimitInput, 'Hard cap'),
    margin: readNumberInput(settingsCapacityMarginInput, 'Safety margin'),
    ...(options?.includePowerSource === true
      ? { powerSource: normalizePowerSource(settingsPowerSourceSelect?.value) }
      : {}),
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
  const { matched, unmatched } = topicsToScenarioIds(enabledTopics);
  const matchedSet = new Set<DebugLoggingScenarioId>(matched);
  document.querySelectorAll<MdSwitchElement>('[data-debug-scenario]').forEach((input) => {
    const el = input;
    const scenarioId = el.dataset.debugScenario;
    el.selected = isDebugLoggingScenarioId(scenarioId) && matchedSet.has(scenarioId);
  });
  const mount = document.getElementById('debug-logging-checkboxes');
  if (mount) renderLegacyTopicsHint(mount, unmatched);
};
