import { render } from 'preact';
import type { WeatherDeviceReading } from '../../../../contracts/src/weatherAdvisorTypes.ts';
import {
  composeForecastReadingLine,
  composeOutdoorReadingLine,
  WEATHER_FORECAST_PICKER_HINT,
  WEATHER_FORECAST_PICKER_LABEL,
  WEATHER_OUTDOOR_PICKER_HINT,
  WEATHER_OUTDOOR_PICKER_LABEL,
  WEATHER_PICKER_NONE,
  WEATHER_SETTINGS_SECTION_HINT,
  type WeatherReadingLine,
} from '../../../../shared-domain/src/weatherInsightCopy.ts';

// Flag-gated "Weather insight" section on the Settings home panel: two native
// `<select>` device pickers (native + `.field` per the form-styling rule —
// never `md-outlined-*`). Rendered into `#weather-insight-settings-mount` by
// the weatherInsight controller; flag off ⇒ `render(null)` ⇒ the mount stays
// empty (structural absence).

export type WeatherDeviceOption = { id: string; label: string };

export type WeatherSettingsSectionProps = {
  outdoorDeviceId: string | null;
  forecastDeviceId: string | null;
  devices: WeatherDeviceOption[];
  outdoorReading: WeatherDeviceReading;
  forecastReading: WeatherDeviceReading;
  onOutdoorChange: (deviceId: string | null) => void;
  onForecastChange: (deviceId: string | null) => void;
};

const DevicePicker = ({ id, label, hint, value, devices, reading, onChange }: {
  id: string;
  label: string;
  hint: string;
  value: string | null;
  devices: WeatherDeviceOption[];
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
        {/* A configured device that no longer appears in the list (deleted /
            still loading) stays selectable so the select doesn't silently
            snap to "No device" and overwrite the setting on next change. */}
        {!knownSelection && value !== null && <option value={value}>{value}</option>}
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

// The dedicated Weather insight sub-page provides the title via its hero; this
// section renders only the intro hint + the two device pickers.
const WeatherSettingsSectionView = (props: WeatherSettingsSectionProps) => (
  <section id="weather-insight-settings" class="settings-form-card weather-settings-section">
    <p class="muted weather-settings-section__hint">{WEATHER_SETTINGS_SECTION_HINT}</p>
    <DevicePicker
      id="weather-outdoor-select"
      label={WEATHER_OUTDOOR_PICKER_LABEL}
      hint={WEATHER_OUTDOOR_PICKER_HINT}
      value={props.outdoorDeviceId}
      devices={props.devices}
      reading={composeOutdoorReadingLine(props.outdoorReading)}
      onChange={props.onOutdoorChange}
    />
    <DevicePicker
      id="weather-forecast-select"
      label={WEATHER_FORECAST_PICKER_LABEL}
      hint={WEATHER_FORECAST_PICKER_HINT}
      value={props.forecastDeviceId}
      devices={props.devices}
      reading={composeForecastReadingLine(props.forecastReading)}
      onChange={props.onForecastChange}
    />
  </section>
);

export const renderWeatherSettingsSection = (
  surface: HTMLElement,
  props: WeatherSettingsSectionProps | null,
): void => {
  render(props === null ? null : <WeatherSettingsSectionView {...props} />, surface);
};
