import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { WEATHER_ADVISOR_SETTINGS } from '../../lib/utils/settingsKeys';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

const settingsWith = (value: unknown): SettingsPort => ({
  get: (key: string) => (key === WEATHER_ADVISOR_SETTINGS ? value : undefined),
  set: () => {},
  unset: () => {},
});

describe('buildWeatherAdvisorSettings', () => {
  it('resolves to disabled when the blob is absent or malformed', () => {
    expect(buildWeatherAdvisorSettings({ settings: settingsWith(undefined) })).toEqual({ enabled: false });
    expect(buildWeatherAdvisorSettings({ settings: settingsWith('yes') })).toEqual({ enabled: false });
    expect(buildWeatherAdvisorSettings({ settings: settingsWith(null) })).toEqual({ enabled: false });
  });

  it('normalizes a valid blob', () => {
    const result = buildWeatherAdvisorSettings({
      settings: settingsWith({ enabled: true, outdoorDeviceId: 'dev-1', forecastDeviceId: 'dev-2' }),
    });
    expect(result).toEqual({
      enabled: true, outdoorDeviceId: 'dev-1', forecastDeviceId: 'dev-2', autoApplyDailyBudget: false,
    });
  });

  it('reads autoApplyDailyBudget only for a strict true', () => {
    expect(buildWeatherAdvisorSettings({
      settings: settingsWith({ enabled: true, outdoorDeviceId: 'dev-1', autoApplyDailyBudget: true }),
    }).autoApplyDailyBudget).toBe(true);
    expect(buildWeatherAdvisorSettings({
      settings: settingsWith({ enabled: true, outdoorDeviceId: 'dev-1', autoApplyDailyBudget: 'true' }),
    }).autoApplyDailyBudget).toBe(false);
  });

  it('trims surrounding whitespace off device ids', () => {
    const result = buildWeatherAdvisorSettings({
      settings: settingsWith({ enabled: true, outdoorDeviceId: ' dev-1 ' }),
    });
    expect(result.outdoorDeviceId).toBe('dev-1');
  });

  it('drops empty or non-string device ids and non-boolean enabled', () => {
    const result = buildWeatherAdvisorSettings({
      settings: settingsWith({ enabled: 'true', outdoorDeviceId: '  ', forecastDeviceId: 7 }),
    });
    expect(result).toEqual({
      enabled: false, outdoorDeviceId: undefined, forecastDeviceId: undefined, autoApplyDailyBudget: false,
    });
  });
});
