import type { WeatherAdvisorReadoutPayload, WeatherDeviceReading } from '../../../contracts/src/weatherAdvisorTypes.ts';
import { SETTINGS_UI_WEATHER_ADVISOR_READOUT_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { WEATHER_ADVISOR_SETTINGS } from '../../../contracts/src/settingsKeys.ts';
import { WEATHER_FIRST_ESTIMATE_TOAST } from '../../../shared-domain/src/weatherInsightCopy.ts';
import { callApi, getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast } from './toast.ts';
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
// One-time "your first estimate is ready" celebration. Persisted (UI-only key)
// so it fires once ever; the module flag also de-dupes within a session.
const WEATHER_FIRST_ESTIMATE_SEEN_KEY = 'weather_advisor_first_estimate_seen';
let firstEstimateSeen = false;
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
  // Celebrate only here: the toast promises tomorrow's outlook, which lives on
  // the Budget tab — not the Settings sub-page (the other fetchReadout caller).
  await maybeCelebrateFirstEstimate();
};

/** Weather-insight sub-page activation hook: render the master switch, then (when on) the validity lines. */
export const refreshWeatherInsightOnWeatherPanel = async (): Promise<void> => {
  // Render unconditionally so the master switch is present even when the feature
  // is off — the sub-page is now the place a disabled feature gets turned on.
  renderSettingsSection();
  if (!currentSettings.enabled) return;
  await fetchReadout();
};

type HomeyDeviceListEntry = { id: string; name: string; class?: string; hasTemperature?: boolean };

const toPickerOption = (device: { id: string; name: string }): WeatherDeviceOption => ({
  id: device.id,
  // Name only — the Homey class ("sensor") disambiguates nothing for the
  // temperature devices a user would pick and just leaks an internal token.
  label: device.name,
});

/**
 * Hard-filter the device list to temperature devices for the pickers: only a
 * device exposing a bare measure_temperature can be read, so listing the rest
 * just invites guaranteed-broken picks. The live validity line then backstops
 * the devices that DO pass — e.g. a forecast device whose bare temperature
 * isn't tomorrow's. (A device exposing temperature only on a sub-capability is
 * excluded here; an empty result is surfaced as an explicit empty state rather
 * than a silent dead-end — see WeatherSettingsSection.) Sorted by name.
 */
export const toTemperatureDeviceOptions = (devices: HomeyDeviceListEntry[]): WeatherDeviceOption[] => (
  devices
    .filter((device) => device.hasTemperature === true)
    .map((device) => toPickerOption(device))
    .sort((a, b) => a.label.localeCompare(b.label))
);

const ensurePickerDevicesLoaded = async (): Promise<void> => {
  if (pickerDevices !== null || pickerDevicesLoading) return;
  pickerDevicesLoading = true;
  try {
    const devices = await callApi<HomeyDeviceListEntry[] | null>('GET', '/homey_devices');
    pickerDevices = toTemperatureDeviceOptions(devices ?? []);
    renderSettingsSection();
  } catch (error) {
    await logSettingsError('Failed to load devices for weather pickers', error, 'weatherInsight');
  } finally {
    pickerDevicesLoading = false;
  }
};

// Serialize persistence so a rapid on/off/on flurry can't land out of order at
// the SDK and leave the wrong final state. Each step writes the LATEST snapshot
// (built at send time from currentSettings), so the last write wins; a failed
// write is swallowed so it can't wedge the chain for later writes.
let persistChain: Promise<void> = Promise.resolve();

const persistWeatherSettings = async (): Promise<void> => {
  const blob = {
    enabled: currentSettings.enabled,
    ...(currentSettings.outdoorDeviceId !== null ? { outdoorDeviceId: currentSettings.outdoorDeviceId } : {}),
    ...(currentSettings.forecastDeviceId !== null ? { forecastDeviceId: currentSettings.forecastDeviceId } : {}),
  };
  // The runtime watches this key (collector reload); our own settings.set
  // event then round-trips handleWeatherAdvisorSettingsChanged → fresh readout.
  await setSetting(WEATHER_ADVISOR_SETTINGS, blob);
};

const writeSettings = async (
  patch: Partial<Pick<WeatherAdvisorUiSettings, 'enabled' | 'outdoorDeviceId' | 'forecastDeviceId'>>,
): Promise<void> => {
  currentSettings = { ...currentSettings, ...patch };
  // Turning the feature on needs the picker list ready for the section it reveals.
  if (patch.enabled === true) void ensurePickerDevicesLoaded();
  renderSettingsSection();
  // Append to the serialized chain, then own the failure here: callers fire this
  // as `void writeSettings(...)`, so a rejected persist must be logged rather
  // than surface as an unhandled rejection.
  persistChain = persistChain.catch(() => {}).then(persistWeatherSettings);
  try {
    await persistChain;
  } catch (error) {
    await logSettingsError('Failed to persist weather settings', error, 'weatherInsight');
  }
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
  // The section always renders the master switch (the feature gate is now the
  // switch, not the nav card's visibility), then the pickers once enabled.
  // The Budget cross-link promises a "tomorrow's outlook" that only exists while
  // the feature is on, so it's hidden when off (it lives outside the Preact mount).
  document.getElementById('weather-see-in-budget')?.toggleAttribute('hidden', !currentSettings.enabled);
  const mount = document.getElementById('weather-insight-settings-mount');
  if (!mount) return;
  renderWeatherSettingsSection(mount, {
    enabled: currentSettings.enabled,
    onEnabledChange: (enabled) => { void writeSettings({ enabled }); },
    pickers: currentSettings.enabled
      ? {
        outdoorDeviceId: currentSettings.outdoorDeviceId,
        forecastDeviceId: currentSettings.forecastDeviceId,
        devices: pickerDevices ?? [],
        // Distinguishes "still loading" from "loaded, no temperature devices" so the
        // section can show an honest empty state instead of a bare empty dropdown.
        devicesLoaded: pickerDevices !== null,
        outdoorReading: readingFor('outdoorDeviceId', 'outdoorReading'),
        forecastReading: readingFor('forecastDeviceId', 'forecastReading'),
        onOutdoorChange: (deviceId) => { void writeSettings({ outdoorDeviceId: deviceId }); },
        onForecastChange: (deviceId) => { void writeSettings({ forecastDeviceId: deviceId }); },
      }
      : null,
  });
};

const reloadSettings = async (): Promise<void> => {
  currentSettings = normalizeSettings(await getSetting(WEATHER_ADVISOR_SETTINGS));
  // Monotonic: once seen this session, never let a reload (which may read a
  // not-yet-propagated persisted value) flip it back and re-fire the toast.
  firstEstimateSeen = firstEstimateSeen || (await getSetting(WEATHER_FIRST_ESTIMATE_SEEN_KEY)) === true;
};

/** Celebrate only on the first ready readout that hasn't been acknowledged yet. */
export const shouldCelebrateFirstEstimate = (
  state: WeatherAdvisorReadoutPayload['state'] | undefined,
  alreadySeen: boolean,
): boolean => state === 'ready' && !alreadySeen;

// Fire once, the first time a READY readout is seen — and only from the Budget
// tab, where the outlook the toast points at is actually visible. Persist the
// seen flag BEFORE the (awaited) toast so a settings event during the toast
// window can't read it still-false and re-fire.
const maybeCelebrateFirstEstimate = async (): Promise<void> => {
  if (!shouldCelebrateFirstEstimate(latestReadout?.state, firstEstimateSeen)) return;
  firstEstimateSeen = true;
  await setSetting(WEATHER_FIRST_ESTIMATE_SEEN_KEY, true);
  await showToast(WEATHER_FIRST_ESTIMATE_TOAST, 'ok');
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
