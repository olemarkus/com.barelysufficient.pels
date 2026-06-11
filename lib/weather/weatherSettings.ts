import type { SettingsPort } from '../ports/homeyRuntime';
import type { WeatherAdvisorSettings } from '../../packages/contracts/src/weatherAdvisorTypes';
import { WEATHER_ADVISOR_SETTINGS } from '../utils/settingsKeys';

const asDeviceId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Normalizes the hidden weather-advisor config blob. Absent or malformed
 * settings resolve to `enabled: false`, so the feature stays fully dark until
 * the blob is explicitly written (via `homey api`; no UI writes it yet).
 */
export function buildWeatherAdvisorSettings(params: { settings: SettingsPort }): WeatherAdvisorSettings {
  const raw = params.settings.get(WEATHER_ADVISOR_SETTINGS) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    return { enabled: false };
  }
  const blob = raw as Record<string, unknown>;
  return {
    enabled: blob.enabled === true,
    outdoorDeviceId: asDeviceId(blob.outdoorDeviceId),
    forecastDeviceId: asDeviceId(blob.forecastDeviceId),
  };
}
