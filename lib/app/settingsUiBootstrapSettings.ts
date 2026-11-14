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
import { DEVICE_POWER_CONTROL_MODES, EV_CHARGING_SESSION_SMOOTHING }
  from '../../packages/shared-domain/src/settings/settingsKeys';
import { normalizeDevicePowerControlModes } from '../../packages/shared-domain/src/settings/devicePowerControlModes';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { readEvChargingSessionSmoothingSettings } from '../device/evChargingSessionSmoothingSettings';

const readPowerControlModes = (settings: SettingsPort): unknown => {
  const raw = settings.get(DEVICE_POWER_CONTROL_MODES);
  const modes = normalizeDevicePowerControlModes(raw);
  if (modes !== null) return modes;
  const keys = readSettingsKeyList(settings);
  return raw == null && keys.status === 'resolved' && !keys.keys.includes(DEVICE_POWER_CONTROL_MODES)
    ? {} : undefined;
};

const readBootstrapSetting = (settings: SettingsPort, key: SettingsUiBootstrapKey): unknown => {
  if (key === EV_CHARGING_SESSION_SMOOTHING) return readEvChargingSessionSmoothingSettings(settings);
  if (key === INVERTER_CURTAILMENT_DEVICES) return readInverterCurtailmentDevices(settings);
  if (key === CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY) return readContinuousBatteryPlanConfigs(settings);
  if (key === DEVICE_POWER_CONTROL_MODES) return readPowerControlModes(settings);
  return settings.get(key);
};

/** Settings reads belong to the application read model; setup only supplies the port. */
export const readSettingsUiBootstrapSettings = (settings: SettingsPort): SettingsUiSettingsPatch['settings'] => (
  Object.fromEntries(SETTINGS_UI_BOOTSTRAP_KEYS.flatMap(key => {
    const value = readBootstrapSetting(settings, key);
    // An unread mode map must not become a bootstrap-authoritative empty map.
    return key === DEVICE_POWER_CONTROL_MODES && value === undefined ? [] : [[key, value]];
  }))
);
