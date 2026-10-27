import type { SettingsUiSettingsPatch } from '../../packages/contracts/src/settingsUiApi';
import { INVERTER_CURTAILMENT_DEVICES } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readInverterCurtailmentDevices } from '../solar/inverterCurtailmentSettings';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../utils/settingsUiBootstrapKeys';

/** Settings reads belong to the application read model; setup only supplies the port. */
export const readSettingsUiBootstrapSettings = (settings: SettingsPort): SettingsUiSettingsPatch['settings'] => (
  Object.fromEntries(SETTINGS_UI_BOOTSTRAP_KEYS.map((key) => [key, key === INVERTER_CURTAILMENT_DEVICES
    ? readInverterCurtailmentDevices(settings) : settings.get(key)]))
);
