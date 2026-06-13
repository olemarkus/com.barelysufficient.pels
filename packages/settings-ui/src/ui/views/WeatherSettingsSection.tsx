import { render } from 'preact';
import type { WeatherDeviceReading } from '../../../../contracts/src/weatherAdvisorTypes.ts';
import { MdSwitch } from './materialWebJSX.tsx';
import {
  composeForecastReadingLine,
  composeLastAutoApply,
  composeOutdoorReadingLine,
  WEATHER_AUTO_APPLY_LABEL,
  WEATHER_AUTO_APPLY_NEEDS_BUDGET,
  WEATHER_AUTO_APPLY_SUPPORTING,
  WEATHER_DISABLED_PITCH,
  WEATHER_ENABLE_LABEL,
  WEATHER_ENABLE_SUPPORTING,
  WEATHER_FORECAST_PICKER_HINT,
  WEATHER_FORECAST_PICKER_LABEL,
  WEATHER_NO_TEMPERATURE_DEVICES,
  WEATHER_OUTDOOR_PICKER_HINT,
  WEATHER_OUTDOOR_PICKER_LABEL,
  WEATHER_PICKER_NONE,
  WEATHER_PICKER_ORPHAN,
  WEATHER_PICKER_SELECTED_LOADING,
  WEATHER_SETTINGS_SECTION_HINT,
  type WeatherReadingLine,
} from '../../../../shared-domain/src/weatherInsightCopy.ts';

// "Weather insight" sub-page body: a master on/off switch (the feature gate),
// then — only while on — two native `<select>` device pickers (native + `.field`
// per the form-styling rule, never `md-outlined-*`). Rendered into
// `#weather-insight-settings-mount` by the weatherInsight controller. The switch
// always renders so a disabled feature can be turned on from the UI; off ⇒ only
// the switch row shows.

export type WeatherDeviceOption = { id: string; label: string };

/** md-switch exposes its state as a `.selected` property (Material Web interop). */
type SwitchElement = HTMLElement & { selected: boolean };

/** Device-picker config — present only when the feature is enabled. */
export type WeatherPickersProps = {
  outdoorDeviceId: string | null;
  forecastDeviceId: string | null;
  devices: WeatherDeviceOption[];
  /** False while the device list is still loading; gates the no-devices empty state. */
  devicesLoaded: boolean;
  outdoorReading: WeatherDeviceReading;
  forecastReading: WeatherDeviceReading;
  onOutdoorChange: (deviceId: string | null) => void;
  onForecastChange: (deviceId: string | null) => void;
  /** Auto-apply the suggested daily budget at each rollup. */
  autoApplyDailyBudget: boolean;
  onAutoApplyChange: (on: boolean) => void;
  /** Whether the daily budget feature is on — when off, auto-apply is inert. */
  dailyBudgetEnabled: boolean;
  /** Last auto-applied budget for the "Last applied" line; null when never applied. */
  lastAutoApply: { dateKey: string; kwh: number } | null;
};

export type WeatherSettingsSectionProps = {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Null while disabled — the pickers only exist once the feature is on. */
  pickers: WeatherPickersProps | null;
};

const DevicePicker = ({ id, label, hint, value, devices, devicesLoaded, reading, onChange }: {
  id: string;
  label: string;
  hint: string;
  value: string | null;
  devices: WeatherDeviceOption[];
  devicesLoaded: boolean;
  reading: WeatherReadingLine | null;
  onChange: (deviceId: string | null) => void;
}) => {
  const knownSelection = value === null || devices.some((device) => device.id === value);
  const onSelectChange = (event: Event) => {
    const raw = (event.currentTarget as HTMLSelectElement).value;
    onChange(raw === '' ? null : raw);
  };
  return (
    <label class="field">
      <span class="field__label pels-text-settings-label">{label}</span>
      <select id={id} class="pels-select hy-nostyle" value={value ?? ''} onChange={onSelectChange}>
        <option value="">{WEATHER_PICKER_NONE}</option>
        {/* A configured device absent from the list stays selectable (value=id) so
            the select can't silently snap to "No device" and overwrite the
            setting. Labelled human-friendly, never the raw id: "no longer
            available" once the list has loaded (genuinely deleted), or a neutral
            placeholder while it's still loading. */}
        {!knownSelection && value !== null && (
          <option value={value}>
            {devicesLoaded ? WEATHER_PICKER_ORPHAN : WEATHER_PICKER_SELECTED_LOADING}
          </option>
        )}
        {devices.map((device) => (
          <option key={device.id} value={device.id}>{device.label}</option>
        ))}
      </select>
      {/* Live validity: confirms the chosen device actually reads a temperature.
          Warn reuses the canonical .field__hint--alert primitive. The static hint
          shows only when there's no live line yet (no device, or pre-first-fetch),
          so a confirmed device isn't followed by a redundant pick-a-device hint. */}
      {reading === null
        ? <small class="field__hint">{hint}</small>
        : (
          <small class={reading.tone === 'warn'
            ? 'field__hint field__hint--alert'
            : 'field__hint weather-picker-status--ok'}>
            {reading.text}
          </small>
        )}
    </label>
  );
};

/** Master on/off row — the feature gate. Always rendered (off ⇒ the only row). */
const MasterSwitch = ({ enabled, onEnabledChange }: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) => (
  <div class="md-switch-row settings-form-card" id="weather-enable-row">
    <MdSwitch
      id="weather-enable-switch"
      aria-label={WEATHER_ENABLE_LABEL}
      {...(enabled ? { selected: true } : {})}
      onChange={(event: Event) => onEnabledChange((event.currentTarget as SwitchElement).selected)}
    />
    <span class="md-switch-row__content">
      <span class="md-switch-row__label pels-text-settings-label">{WEATHER_ENABLE_LABEL}</span>
      <small class="field__hint">{WEATHER_ENABLE_SUPPORTING}</small>
    </span>
  </div>
);

const DevicePickers = ({ pickers }: { pickers: WeatherPickersProps }) => (
  <section id="weather-insight-settings" class="settings-form-card weather-settings-section">
    {pickers.devicesLoaded && pickers.devices.length === 0
      ? <p class="muted weather-settings-section__hint" id="weather-no-devices">{WEATHER_NO_TEMPERATURE_DEVICES}</p>
      : <p class="muted weather-settings-section__hint">{WEATHER_SETTINGS_SECTION_HINT}</p>}
    <DevicePicker
      id="weather-outdoor-select"
      label={WEATHER_OUTDOOR_PICKER_LABEL}
      hint={WEATHER_OUTDOOR_PICKER_HINT}
      value={pickers.outdoorDeviceId}
      devices={pickers.devices}
      devicesLoaded={pickers.devicesLoaded}
      reading={composeOutdoorReadingLine(pickers.outdoorReading)}
      onChange={pickers.onOutdoorChange}
    />
    <DevicePicker
      id="weather-forecast-select"
      label={WEATHER_FORECAST_PICKER_LABEL}
      hint={WEATHER_FORECAST_PICKER_HINT}
      value={pickers.forecastDeviceId}
      devices={pickers.devices}
      devicesLoaded={pickers.devicesLoaded}
      reading={composeForecastReadingLine(pickers.forecastReading)}
      onChange={pickers.onForecastChange}
    />
  </section>
);

/**
 * Auto-apply row — opt in to letting the suggested daily budget set the daily
 * budget each rollup. Inert hint shows only once the user has turned it on but
 * the daily budget is off (so the toggle's no-op is explained at the moment it
 * matters); the "Last applied" line confirms it's actually acting.
 */
const AutoApplyRow = ({ pickers }: { pickers: WeatherPickersProps }) => (
  <div class="md-switch-row settings-form-card" id="weather-auto-apply-row">
    <MdSwitch
      id="weather-auto-apply-switch"
      aria-label={WEATHER_AUTO_APPLY_LABEL}
      {...(pickers.autoApplyDailyBudget ? { selected: true } : {})}
      onChange={(event: Event) => pickers.onAutoApplyChange((event.currentTarget as SwitchElement).selected)}
    />
    <span class="md-switch-row__content">
      <span class="md-switch-row__label pels-text-settings-label">{WEATHER_AUTO_APPLY_LABEL}</span>
      <small class="field__hint">{WEATHER_AUTO_APPLY_SUPPORTING}</small>
      {pickers.autoApplyDailyBudget && !pickers.dailyBudgetEnabled && (
        <small class="field__hint field__hint--alert" id="weather-auto-apply-needs-budget">
          {WEATHER_AUTO_APPLY_NEEDS_BUDGET}
        </small>
      )}
      {pickers.lastAutoApply !== null && (
        <small class="field__hint weather-picker-status--ok" id="weather-auto-apply-last">
          {composeLastAutoApply(pickers.lastAutoApply.dateKey, pickers.lastAutoApply.kwh)}
        </small>
      )}
    </span>
  </div>
);

/** Off-state body: a payoff-led pitch so the off page sells the feature. */
const DisabledPitch = () => (
  <section id="weather-disabled-pitch" class="settings-form-card">
    <p class="pels-card-supporting">{WEATHER_DISABLED_PITCH}</p>
  </section>
);

// The dedicated Weather insight sub-page provides the title via its hero; this
// body renders the master switch, then either the off-state pitch or the device
// pickers depending on whether the feature is on.
const WeatherSettingsSectionView = (props: WeatherSettingsSectionProps) => (
  <div id="weather-insight-settings-body">
    <MasterSwitch enabled={props.enabled} onEnabledChange={props.onEnabledChange} />
    {props.enabled && props.pickers !== null
      ? (
        <>
          <DevicePickers pickers={props.pickers} />
          <AutoApplyRow pickers={props.pickers} />
        </>
      )
      : <DisabledPitch />}
  </div>
);

export const renderWeatherSettingsSection = (
  surface: HTMLElement,
  props: WeatherSettingsSectionProps,
): void => {
  render(<WeatherSettingsSectionView {...props} />, surface);
};
