import { SETTINGS_UI_PRICES_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { invalidateApiCache } from './homey.ts';
import { refreshAfterSetupRecommendations } from './recommendations.ts';
import { writePriceOptimizationSettings } from './priceConfigSettingsIo.ts';

export const savePriceOptimizationSettings = async () => {
  await writePriceOptimizationSettings();
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  await refreshAfterSetupRecommendations();
};
