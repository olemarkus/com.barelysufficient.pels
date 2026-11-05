import { requirePelsHost } from '../../lib/app/pelsHost';
import type { PriceSetupSuggestion } from '../../packages/contracts/src/settingsUi/prices';
import {
  getSettingsUiPricesPayload,
  refreshSettingsUiGridTariff,
  refreshSettingsUiPrices,
} from '../settingsUiApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const pricesRoutes = defineRoutes({
  ui_prices: ({ homey }: ApiContext) => getSettingsUiPricesPayload({ homey }),
  ui_refresh_prices: ({ homey }: ApiContext) => refreshSettingsUiPrices({ homey }),
  ui_refresh_grid_tariff: ({ homey }: ApiContext) => refreshSettingsUiGridTariff({ homey }),
  // The owner performs the location lookup; startup is unavailable, not no suggestion.
  ui_price_setup_suggestion: ({ homey }: ApiContext): Promise<PriceSetupSuggestion> => (
    requirePelsHost(homey).suggestPriceSetup()
  ),
});
