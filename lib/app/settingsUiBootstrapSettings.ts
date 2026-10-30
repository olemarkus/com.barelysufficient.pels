import type {
  SettingsUiBootstrapKey,
  SettingsUiSettingsPatch,
} from '../../packages/contracts/src/settingsUi/bootstrap';
import { INVERTER_CURTAILMENT_DEVICES } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import { readContinuousBatteryPlanConfigs } from '../battery/continuousBatteryPlanSettings';
import { CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY } from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readInverterCurtailmentDevices } from '../solar/inverterCurtailmentSettings';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../utils/settingsUiBootstrapKeys';

const readBootstrapSetting = (settings: SettingsPort, key: SettingsUiBootstrapKey): unknown => {
  if (key === INVERTER_CURTAILMENT_DEVICES) return readInverterCurtailmentDevices(settings);
  if (key === CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY) return readContinuousBatteryPlanConfigs(settings);
  return settings.get(key);
};

/** Settings reads belong to the application read model; setup only supplies the port. */
export const readSettingsUiBootstrapSettings = (settings: SettingsPort): SettingsUiSettingsPatch['settings'] => (
  Object.fromEntries(SETTINGS_UI_BOOTSTRAP_KEYS.map(key => [key, readBootstrapSetting(settings, key)]))
);
