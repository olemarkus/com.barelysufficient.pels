import { SETTINGS_UI_PRICES_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { invalidateApiCache } from './homey.ts';
import { refreshAfterSetupRecommendations } from './recommendations.ts';
import { writePriceOptimizationSettings } from './priceConfigSettingsIo.ts';
import { defaultPriceOptimizationConfig, state } from './state.ts';

export const savePriceOptimizationSettings = async () => {
  await writePriceOptimizationSettings();
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  await refreshAfterSetupRecommendations();
};

/** One device's Price-based control, as the owner set it: on the device list or in setup. */
export const saveDevicePriceEnabled = async (deviceId: string, enabled: boolean): Promise<void> => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  state.priceOptimizationSettings[deviceId].enabled = enabled;
  state.priceOptimizationSettings[deviceId].priceConfigured = true;
  await savePriceOptimizationSettings();
};
