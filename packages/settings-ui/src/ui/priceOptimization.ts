import { SETTINGS_UI_PRICES_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { invalidateApiCache } from './homey.ts';
import { refreshAfterSetupRecommendations } from './recommendations.ts';
import type { SettingsUiDeviceView } from './state.ts';
import { updatePriceConfigDevices } from './priceConfig.ts';
import { writePriceOptimizationSettings } from './priceConfigSettingsIo.ts';

// Re-exported for `priceOpt.ts`; the underlying helper lives in `state.ts`
// to avoid a circular import between this module and `priceConfig.ts`.


export const savePriceOptimizationSettings = async () => {
  await writePriceOptimizationSettings();
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  await refreshAfterSetupRecommendations();
};

export const renderPriceOptimization = (devices: SettingsUiDeviceView[]) => {
  updatePriceConfigDevices(devices);
};
