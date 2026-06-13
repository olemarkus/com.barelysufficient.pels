import type { WeatherAdvisorReadoutPayload, WeatherDeviceReading } from '../../../contracts/src/weatherAdvisorTypes.ts';
import { SETTINGS_UI_WEATHER_ADVISOR_READOUT_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { WEATHER_ADVISOR_SETTINGS } from '../../../contracts/src/settingsKeys.ts';
import { callApi, getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import type { WeatherInsightCardData } from './views/WeatherInsight.tsx';
import {
  renderWeatherSettingsSection,
  type WeatherDeviceOption,
} from './views/WeatherSettingsSection.tsx';

// Module-state controller for the hidden Weather insight surface (mirrors the
// budgetRedesign.ts pattern): owns the flag/settings snapshot, the latest
// readout payload, and the Settings-section render. The Budget page consumes
// it through `getWeatherInsightView()` inside `budgetRedesign.buildProps()`;
// flag off ⇒ null ⇒ structural absence. Render and navigation hooks are
// injected (setWeatherInsightRenderer) so this module never imports
// budgetRedesign/realtime — keeping the import graph acyclic.

type WeatherAdvisorUiSettings = {
  enabled: boolean;
  outdoorDeviceId: string | null;
  forecastDeviceId: string | null;
};

const DISABLED_SETTINGS: WeatherAdvisorUiSettings = {
  enabled: false,
  outdoorDeviceId: null,
  forecastDeviceId: null,
};

let currentSettings: WeatherAdvisorUiSettings = DISABLED_SETTINGS;
let latestReadout: WeatherAdvisorReadoutPayload | null = null;
let readoutFailed = false;
let pickerDevices: WeatherDeviceOption[] | null = null;
let pickerDevicesLoading = false;
// Injected by budgetRedesign at module init (same shape as setBudgetAdjustRenderer).
let renderBudgetSurface: () => void = () => {};

const asDeviceId = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value : null
);

const normalizeSettings = (raw: unknown): WeatherAdvisorUiSettings => {
  if (typeof raw !== 'object' || raw === null) return DISABLED_SETTINGS;
  const blob = raw as Record<string, unknown>;
  return {
    enabled: blob.enabled === true,
    outdoorDeviceId: asDeviceId(blob.outdoorDeviceId),
    forecastDeviceId: asDeviceId(blob.forecastDeviceId),
  };
};

export const setWeatherInsightRenderer = (renderer: () => void): void => {
  renderBudgetSurface = renderer;
};

/** Null = flag off → BudgetOverview renders no weather DOM at all. */
export const getWeatherInsightView = (): WeatherInsightCardData | null => (
  currentSettings.enabled ? { readout: latestReadout, fetchFailed: readoutFailed } : null
);

const fetchReadout = async (): Promise<void> => {
  try {
    latestReadout = await callApi<WeatherAdvisorReadoutPayload | null>(
      'GET',
      SETTINGS_UI_WEATHER_ADVISOR_READOUT_PATH,
    ) ?? null;
    readoutFailed = false;
  } catch (error) {
    readoutFailed = true;
    await logSettingsError('Failed to load weather insight readout', error, 'weatherInsight');
  }
  renderBudgetSurface();
  // The readout also carries the live device readings the Settings pickers show,
  // so refresh that surface too whenever a fresh readout lands.
  renderSettingsSection();
};

/** Budget-tab activation hook (realtime.ts): lazy fetch only while the flag is on. */
export const refreshWeatherInsightOnBudgetTab = async (): Promise<void> => {
  if (!currentSettings.enabled) return;
  await fetchReadout();
};

/** Weather-insight sub-page activation hook: refresh the picker validity lines from a live readout. */
export const refreshWeatherInsightOnWeatherPanel = async (): Promise<void> => {
  if (!currentSettings.enabled) return;
  await fetchReadout();
};

const toPickerOption = (device: { id: string; name: string }): WeatherDeviceOption => ({
  id: device.id,
  // Name only — the Homey class ("sensor") disambiguates nothing for the
  // temperature devices a user would pick and just leaks an internal token.
  label: device.name,
});

const ensurePickerDevicesLoaded = async (): Promise<void> => {
  if (pickerDevices !== null || pickerDevicesLoading) return;
  pickerDevicesLoading = true;
  try {
    const devices = await callApi<Array<{ id: string; name: string; class?: string }> | null>(
      'GET',
      '/homey_devices',
    );
    pickerDevices = (devices ?? [])
      .map((device) => toPickerOption(device))
      .sort((a, b) => a.label.localeCompare(b.label));
    renderSettingsSection();
  } catch (error) {
    await logSettingsError('Failed to load devices for weather pickers', error, 'weatherInsight');
  } finally {
    pickerDevicesLoading = false;
  }
};

const writeDeviceSelection = async (
  patch: Partial<Pick<WeatherAdvisorUiSettings, 'outdoorDeviceId' | 'forecastDeviceId'>>,
): Promise<void> => {
  currentSettings = { ...currentSettings, ...patch };
  renderSettingsSection();
  const blob = {
    enabled: currentSettings.enabled,
    ...(currentSettings.outdoorDeviceId !== null ? { outdoorDeviceId: currentSettings.outdoorDeviceId } : {}),
    ...(currentSettings.forecastDeviceId !== null ? { forecastDeviceId: currentSettings.forecastDeviceId } : {}),
  };
  // The runtime watches this key (collector reload); our own settings.set
  // event then round-trips handleWeatherAdvisorSettingsChanged → fresh readout.
  await setSetting(WEATHER_ADVISOR_SETTINGS, blob);
};

// Before the first readout lands, the picker shows no status line (the readout
// is what carries the live reading). A configured device's line pops in on the
// next fetch (settings-tab activation or a selection write).
const NO_READING = { status: 'no_device' } as const;

// Only trust a reading when the readout describes the CURRENTLY selected device
// for THAT picker. Right after a selection change the previous readout lingers
// until the re-fetch lands; showing its reading would attribute the old device's
// value to the just-picked one. Checked PER-PICKER so changing one device doesn't
// blank the other's still-valid line; an unmatched picker falls back to its hint.
const readingFor = (
  pickerId: 'outdoorDeviceId' | 'forecastDeviceId',
  readingKey: 'outdoorReading' | 'forecastReading',
): WeatherDeviceReading => (
  latestReadout !== null && latestReadout.settings[pickerId] === currentSettings[pickerId]
    ? latestReadout[readingKey]
    : NO_READING
);

const renderSettingsSection = (): void => {
  // The nav card is the flag gate for the whole sub-page: unhidden only while the
  // feature is enabled, so the hidden feature stays hidden (and unreachable).
  document.getElementById('weather-insight-nav-card')?.toggleAttribute('hidden', !currentSettings.enabled);
  const mount = document.getElementById('weather-insight-settings-mount');
  if (!mount) return;
  renderWeatherSettingsSection(mount, currentSettings.enabled
    ? {
      outdoorDeviceId: currentSettings.outdoorDeviceId,
      forecastDeviceId: currentSettings.forecastDeviceId,
      devices: pickerDevices ?? [],
      outdoorReading: readingFor('outdoorDeviceId', 'outdoorReading'),
      forecastReading: readingFor('forecastDeviceId', 'forecastReading'),
      onOutdoorChange: (deviceId) => { void writeDeviceSelection({ outdoorDeviceId: deviceId }); },
      onForecastChange: (deviceId) => { void writeDeviceSelection({ forecastDeviceId: deviceId }); },
    }
    : null);
};

const reloadSettings = async (): Promise<void> => {
  currentSettings = normalizeSettings(await getSetting(WEATHER_ADVISOR_SETTINGS));
};

/** Boot hook: prime the flag from the (bootstrap-cached) setting and render the section. */
export const initWeatherInsight = async (): Promise<void> => {
  await reloadSettings();
  if (currentSettings.enabled) void ensurePickerDevicesLoaded();
  renderSettingsSection();
};

/** settings.set / settings.unset hook for `weather_advisor_settings` (realtime.ts). */
export const handleWeatherAdvisorSettingsChanged = async (): Promise<void> => {
  await reloadSettings();
  if (!currentSettings.enabled) {
    latestReadout = null;
    readoutFailed = false;
    renderSettingsSection();
    renderBudgetSurface();
    return;
  }
  void ensurePickerDevicesLoaded();
  renderSettingsSection();
  await fetchReadout();
};
